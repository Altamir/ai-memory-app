import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.mjs';
import { cliEnv } from './cli.mjs';

// Jobs de manutenção: spawn do binário, buffer de linhas limitado e
// assinantes SSE recebendo cada linha em tempo real.

const jobs = new Map();
const history = [];

export function getJob(id) {
  return jobs.get(id) || null;
}

export function jobDetail(id) {
  const job = jobs.get(id);
  if (!job) return null;
  return { ...jobSummary(job), lineCount: job.lines.length };
}

export function listJobs() {
  return history.slice(0, config.jobHistoryLimit).map(jobSummary);
}

function jobSummary(j) {
  return {
    id: j.id,
    command: j.command,
    args: j.displayArgs,
    group: j.group,
    status: j.status,
    exitCode: j.exitCode,
    startedAt: j.startedAt,
    endedAt: j.endedAt,
    durationMs: j.endedAt ? j.endedAt - j.startedAt : null,
  };
}

export function createJob(command, args, { timeoutMs = 3_600_000, group = 'actions' } = {}) {
  const id = randomUUID();
  const job = {
    id,
    command,
    group,
    displayArgs: args.map((a) => (String(a).includes(' ') ? JSON.stringify(a) : a)),
    status: 'running',
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    lines: [],
    droppedLines: 0,
    partial: { out: '', err: '' },
    subscribers: new Set(),
  };

  let child;
  try {
    child = spawn(config.bin, ['--data-dir', config.dataDir, ...args], {
      env: cliEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    job.status = 'error';
    job.exitCode = null;
    job.endedAt = Date.now();
    append(job, 'err', `falha ao iniciar: ${err.message}\n`);
    register(job);
    return job;
  }

  job.pid = child.pid;
  register(job);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // já saiu
    }
  }, timeoutMs);

  child.stdout.on('data', (d) => appendChunk(job, 'out', d));
  child.stderr.on('data', (d) => appendChunk(job, 'err', d));
  child.on('error', (err) => append(job, 'err', `erro de execução: ${err.message}\n`));
  child.on('close', (code) => {
    clearTimeout(timer);
    flushPartial(job);
    job.exitCode = code;
    job.status = timedOut ? 'timeout' : code === 0 ? 'ok' : 'error';
    job.endedAt = Date.now();
    if (timedOut) append(job, 'err', 'tempo limite excedido — processo encerrado\n');
    append(job, 'sys', `— fim (código ${code ?? '?'}${timedOut ? ', timeout' : ''}) —\n`);
    for (const sub of job.subscribers) sub.end();
    job.subscribers.clear();
  });

  return job;
}

function register(job) {
  jobs.set(job.id, job);
  history.unshift(job);
  if (history.length > config.jobHistoryLimit * 2) {
    for (const old of history.splice(config.jobHistoryLimit * 2)) jobs.delete(old.id);
  }
}

const MAX_LINE = 2000;
// logs da CLI vêm com cores ANSI; o painel estiliza por classe, não por escape
const ANSI = /\x1B\[[0-9;]*[A-Za-z]|\x1B\][^\x07]*\x07/g;

function appendChunk(job, kind, buf) {
  // chunks de stream não alinham com quebras de linha: acumula linha parcial
  job.partial[kind] = (job.partial[kind] || '') + buf.toString('utf8');
  const parts = job.partial[kind].split('\n');
  job.partial[kind] = parts.pop(); // sobras sem \n ficam para o próximo chunk
  for (const line of parts) append(job, kind, `${line.replace(ANSI, '')}\n`);
}

function flushPartial(job) {
  for (const kind of ['out', 'err']) {
    if (job.partial[kind]) {
      append(job, kind, `${job.partial[kind].replace(ANSI, '')}\n`);
      job.partial[kind] = '';
    }
  }
}

function append(job, kind, text) {
  if (!text) return;
  // stderr da CLI mistura logs INFO/WARN (normais) com o erro real; só o erro fica vermelho
  if (kind === 'err' && /^\s*(INFO|DEBUG)\b/.test(text)) kind = 'sys';
  const clipped = text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…\n` : text;
  if (job.lines.length >= config.jobLineLimit) {
    job.lines.shift();
    job.droppedLines += 1;
  }
  job.lines.push({ kind, text: clipped });
  for (const sub of job.subscribers) sub.send({ kind, text: clipped });
}

export function subscribe(jobId, res) {
  const job = jobs.get(jobId);
  if (!job) return false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');

  if (job.droppedLines > 0) {
    res.write(`data: ${JSON.stringify({ kind: 'sys', text: `— ${job.droppedLines} linhas antigas omitidas —\n` })}\n\n`);
  }
  for (const line of job.lines) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  if (job.status !== 'running') {
    res.write('event: end\ndata: {}\n\n');
    res.end();
    return true;
  }

  const sub = {
    send: (line) => {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    },
    end: () => {
      res.write('event: end\ndata: {}\n\n');
      res.end();
    },
  };
  job.subscribers.add(sub);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  res.on('close', () => {
    clearInterval(heartbeat);
    job.subscribers.delete(sub);
  });
  return true;
}
