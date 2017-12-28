const spawn = require('child_process').spawn;
const path = require('path');
const fs = require('fs');

class TestsRunner {
  constructor(config) {
    this.config = config;
    this.executors = new Set();
    this.promise = null;
    this.stopping = false;
    this.nextFiles = [];
  }

  runTestFiles(testFiles) {
    this.nextFiles = testFiles;

    if (this.promise) {
      this.stop();

      return this.promise.then(() => {
        // Обработка случая, когда следующий runTestFiles пришел до того,
        // как отработал предыдущий stop
        if (this.nextFiles === testFiles) {
          return this.startTestFiles(this.nextFiles);
        }

        return Promise.resolve();
      });
    }

    return this.startTestFiles(testFiles);
  }

  startTestFiles(testFiles) {
    this.stopping = false;

    if (testFiles.length === 0) return Promise.resolve();

    let resolve;
    this.promise = new Promise(r => { resolve = r; });

    const parallelTestsCount = this.config.parallelTestsCount || 1;
    const timeout = this.config.timeout || 30000;
    const retries = this.config.retries || 0;

    const args = [];
    args.push('--retries', retries);
    args.push('--timeout', timeout);

    if (!this.config.noColors) {
      args.push('--colors');
    }

    const startTime = Date.now();
    let result = 0;
    let totalPassing = 0;
    let totalPending = 0;
    let totalFailing = 0;
    const filesWithFailures = [];

    let testFileNum = 0;

    const startExecutor = done => {
      const testFile = testFiles[testFileNum];
      testFileNum += 1;

      log(`Запуск теста ${testFile}`);

      const p = spawn(path.resolve('node_modules/.bin/mocha'), args.concat([testFile]));
      this.executors.add(p);

      let passing = 0;
      let pending = 0;
      let failing = 0;

      const parts = testFile.split('/');
      const prefix = parts[parts.length - 1];

      let logs = '';

      const logData = data => {
        const str = data.toString('utf8');
        logs += str;

        const passingRe = /(\d+) passing/;
        const pendingRe = /(\d+) pending/;
        const failingRe = /(\d+) failing/;

        let res;

        res = passingRe.exec(str);
        if (res) {
          passing = Number(res[1]);
        }

        res = pendingRe.exec(str);
        if (res) {
          pending = Number(res[1]);
        }

        res = failingRe.exec(str);
        if (res) {
          failing = Number(res[1]);
        }

        process.stdout.write(`${prefix} ${str}`);
      };
      p.stdout.on('data', logData);
      p.stderr.on('data', logData);

      p.on('close', code => {
        if (this.config.separatedLogs) {
          try {
            fs.mkdirSync('test-logs');
          } catch (e) {
            // Директория уже существует
          }

          fs.writeFileSync(`test-logs/${prefix}.log`, logs);
        }

        log(`child process exited with code ${code}`);
        this.executors.delete(p);
        done(testFile, code, passing, pending, failing);
      });
    };

    const run = () => {
      log(`stopping: ${this.stopping} executors: ${this.executors.size} parallelTestsCount: ${parallelTestsCount} testFileNum: ${testFileNum} testFiles: ${testFiles.length}`);

      const onFinish = (testFile, code, passing, pending, failing) => {
        totalPassing += passing;
        totalPending += pending;
        totalFailing += failing;

        if (code) {
          result = code;
          filesWithFailures.push({ name: testFile, failing });
        }

        run();
      };

      while (!this.stopping && this.executors.size < parallelTestsCount && testFileNum < testFiles.length) {
        startExecutor(onFinish);
      }

      if (this.executors.size === 0 && (this.stopping || testFileNum >= testFiles.length)) {
        log(`E2E тесты завершились за ${formatTime(Math.floor(Date.now() - startTime) / 1000)}`);

        if (filesWithFailures.length) {
          log('\nПроблемные файлы:');
          filesWithFailures.forEach((f, index) => {
            log(`${index + 1}. ${f.name} (провалено тестов: ${f.failing})`);
          });
        }

        log();
        log(`${totalPassing} passing`);
        log(`${totalPending} pending`);
        log(`${totalFailing} failing`);

        this.promise = null;
        resolve(result);
      }
    };

    run();

    return this.promise;
  }

  stop() {
    if (this.stopping) return;

    log('ОСТАНОВКА ТЕСТИРОВАНИЯ');
    log(`executors.size = ${this.executors.size}`);
    this.stopping = true;
    this.executors.forEach(e => {
      // Только на сигнал SIGINT у mocha стоит корректный обработчик.
      e.kill('SIGINT');
      log(`kill executor ${e.pid}`);
    });
  }
}

function formatTime(time) {
  const hours = Math.floor(time / 3600);
  const mins = Math.floor((time % 3600) / 60);
  const secs = Math.floor(time % 60);

  let result = '';

  if (hours > 0) result = `${result}${hours} ч.`;
  if (mins > 0) result = `${result} ${mins} мин.`;
  if (secs > 0) result = `${result} ${secs} сек.`;

  return result;
}

function log(msg) {
  console.log(msg);
}

module.exports = TestsRunner;
