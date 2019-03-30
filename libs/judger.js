const enums = require('./enums');
const util = require('util');
const winston = require('winston');
const msgPack = require('msgpack-lite');
const fs = Promise.promisifyAll(require('fs-extra'));
const interface = require('./judger_interfaces');
const judgeResult = require('./judgeResult');

const judgeStateCache = new Map();
const progressPusher = require('../modules/socketio');

function getRunningTaskStatusString(result) {
  let isPending = status => [0, 1].includes(status);
  let allFinished = 0, allTotal = 0;
  for (let subtask of result.judge.subtasks) {
    for (let curr of subtask.cases) {
      allTotal++;
      if (!isPending(curr.status)) allFinished++;
    }
  }

  return `Running ${allFinished}/${allTotal}`;
}

let judgeQueue;

async function connect() {
  const JudgeState = syzoj.model('judge_state');

  judgeQueue = {
    redisZADD: util.promisify(syzoj.redis.zadd).bind(syzoj.redis),
    redisBZPOPMAX: util.promisify(syzoj.redis.bzpopmax).bind(syzoj.redis),
    async push(data, priority) {
      return await this.redisZADD('judge', priority, JSON.stringify(data));
    },
    async poll(timeout) {
      const result = await this.redisBZPOPMAX('judge', timeout);
      if (!result) return null;

      return {
        data: JSON.parse(result[1]),
        priority: result[2]
      };
    }
  };

  const judgeNamespace = syzoj.socketIO.of('judge');
  judgeNamespace.on('connect', socket => {
    winston.info(`Judge client ${socket.id} connected.`);

    let pendingAckTaskObj = null, waitingForTask = false;
    socket.on('waitForTask', async (token, ack) => {
      // Ignore requests with invalid token.
      if (token != syzoj.config.judge_token) {
        winston.warn(`Judge client ${socket.id} emitted waitForTask with invalid token.`);
        return;
      }

      ack();

      if (waitingForTask) {
        winston.verbose(`Judge client ${socket.id} emitted waitForTask, but already waiting, ignoring.`);
        return;
      }

      waitingForTask = true;

      winston.verbose(`Judge client ${socket.id} emitted waitForTask.`);

      // Poll the judge queue, timeout = 10s.
      let obj;
      while (socket.connected && !obj) {
        obj = await judgeQueue.poll(10);
      }

      if (!obj) {
        winston.verbose(`Judge client ${socket.id} disconnected, stop poll the queue.`);
        // Socket disconnected and no task got.
        return;
      }

      // Re-push to queue if got task but judge client already disconnected.
      if (socket.disconnected) {
        winston.verbose(`Judge client ${socket.id} got task but disconnected re-pushing task to queue.`);
        judgeQueue.push(obj.data, obj.priority);
        return;
      }

      // Send task to judge client, and wait for ack.
      const task = obj.data;
      pendingAckTaskObj = obj;
      winston.verbose(`Sending task ${task.content.taskId} to judge client ${socket.id}.`);
      socket.emit('onTask', msgPack.encode(task), () => {
        // Acked.
        winston.verbose(`Judge client ${socket.id} acked task ${task.content.taskId}.`);
        pendingAckTaskObj = null;
        waitingForTask = false;
      });
    });

    socket.on('disconnect', reason => {
      winston.info(`Judge client ${socket.id} disconnected, reason = ${util.inspect(reason)}.`);
      if (pendingAckTaskObj) {
        // A task sent but not acked, push to queue again.
        winston.warn(`Re-pushing task ${pendingAckTaskObj.data.content.taskId} to judge queue.`);
        judgeQueue.push(pendingAckTaskObj.data, pendingAckTaskObj.priority);
        pendingAckTaskObj = null;
      }
    });

    socket.on('reportProgress', async (token, payload) => {
      // Ignore requests with invalid token.
      if (token !== syzoj.config.judge_token) {
        winston.warn(`Judge client ${socket.id} emitted reportProgress with invalid token.`);
        return;
      }

      const progress = msgPack.decode(payload);
      winston.verbose(`Got progress from progress exchange, id: ${progress.taskId}`);

      if (progress.type === interface.ProgressReportType.Started) {
        progressPusher.createTask(progress.taskId);
        judgeStateCache.set(progress.taskId, {
          result: 'Compiling',
          score: 0,
          time: 0,
          memory: 0
        });
      } else if (progress.type === interface.ProgressReportType.Compiled) {
        progressPusher.updateCompileStatus(progress.taskId, progress.progress);
      } else if (progress.type === interface.ProgressReportType.Progress) {
        const convertedResult = judgeResult.convertResult(progress.taskId, progress.progress);
        judgeStateCache.set(progress.taskId, {
          result: getRunningTaskStatusString(progress.progress),
          score: convertedResult.score,
          time: convertedResult.time,
          memory: convertedResult.memory
        });
        progressPusher.updateProgress(progress.taskId, progress.progress);
      } else if (progress.type === interface.ProgressReportType.Finished) {
        progressPusher.updateResult(progress.taskId, progress.progress);
        setTimeout(() => {
          judgeStateCache.delete(progress.taskId);
        }, 5000);
      } else if (progress.type === interface.ProgressReportType.Reported) {
        progressPusher.cleanupProgress(progress.taskId);
      }
    });

    socket.on('reportResult', async (token, payload) => {
      // Ignore requests with invalid token.
      if (token !== syzoj.config.judge_token) {
        winston.warn(`Judge client ${socket.id} emitted reportResult with invalid token.`);
        return;
      }

      const result = msgPack.decode(payload);
      winston.verbose('Received report for task ' + result.taskId);

      const judge_state = await JudgeState.findOne({
        where: {
          task_id: result.taskId
        }
      });

      if (result.type === interface.ProgressReportType.Finished) {
        const convertedResult = judgeResult.convertResult(result.taskId, result.progress);
        winston.verbose('Reporting report finished: ' + result.taskId);
        progressPusher.cleanupProgress(result.taskId);

        if (!judge_state) return;
        judge_state.score = convertedResult.score;
        judge_state.pending = false;
        judge_state.status = convertedResult.statusString;
        judge_state.total_time = convertedResult.time;
        judge_state.max_memory = convertedResult.memory;
        judge_state.result = convertedResult.result;
        await judge_state.save();
        await judge_state.updateRelatedInfo();
      } else if (result.type == interface.ProgressReportType.Compiled) {
        if (!judge_state) return;
        judge_state.compilation = result.progress;
        await judge_state.save();
      } else {
        winston.error('Unsupported result type: ' + result.type);
      }
    });
  });
}
module.exports.connect = connect;

module.exports.judge = async function (judge_state, problem, priority) {
  let type, param, extraData = null;
  switch (problem.type) {
    case 'submit-answer':
      type = enums.ProblemType.AnswerSubmission;
      param = null;
      extraData = await fs.readFileAsync(syzoj.model('file').resolvePath('answer', judge_state.code));
      break;
    case 'interaction':
      type = enums.ProblemType.Interaction;
      param = {
        language: judge_state.language,
        code: judge_state.code,
        timeLimit: problem.time_limit,
        memoryLimit: problem.memory_limit,
      }
      break;
    default:
      type = enums.ProblemType.Standard;
      param = {
        language: judge_state.language,
        code: judge_state.code,
        timeLimit: problem.time_limit,
        memoryLimit: problem.memory_limit,
        fileIOInput: problem.file_io ? problem.file_io_input_name : null,
        fileIOOutput: problem.file_io ? problem.file_io_output_name : null
      };
      break;
  }

  const content = {
    taskId: judge_state.task_id,
    testData: problem.id.toString(),
    type: type,
    priority: priority,
    param: param
  };

  judgeQueue.push({
    content: content,
    extraData: extraData
  }, priority);
}

module.exports.getCachedJudgeState = taskId => judgeStateCache.get(taskId);
