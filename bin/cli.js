#!/usr/bin/env node
const { Command } = require('commander');
const { execSync } = require('child_process');
const path = require('path');

const program = new Command();
const composeFile = path.join(__dirname, '..', 'docker-compose.yml');

program
  .name('gobouncer')
  .description('CLI to run GoBouncer rate limiter via Docker');

program
  .command('up')
  .description('Start GoBouncer + Redis in Docker')
  .option('-p, --port <port>', 'Port to expose', '8080')
  .action((opts) => {
    execSync(`docker compose -f ${composeFile} up --build -d`, {
      stdio: 'inherit',
      env: { ...process.env, PORT: opts.port },
    });
    console.log(`✅ GoBouncer running at http://localhost:${opts.port}`);
  });

program
  .command('down')
  .description('Stop GoBouncer containers')
  .action(() => {
    execSync(`docker compose -f ${composeFile} down`, { stdio: 'inherit' });
  });

program
  .command('logs')
  .description('Tail GoBouncer logs')
  .action(() => {
    execSync(`docker compose -f ${composeFile} logs -f`, { stdio: 'inherit' });
  });

program.parse();