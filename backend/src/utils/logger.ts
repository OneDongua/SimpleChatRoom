import fs from 'fs-extra';

const PATH_LOG = 'latest.log';

export default function () {
  // 创建写入流
  const logStream = fs.createWriteStream(PATH_LOG);

  // 保存原始的 console 方法
  const consoleLog = console.log;
  const consoleError = console.error;
  const consoleWarn = console.warn;
  const consoleInfo = console.info;

  // 日志写入函数
  const writeLog = (level: string, args: any[]) => {
    const timestamp = new Date().toISOString();
    const message = args.map(arg =>
      (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ');

    // 写入日志文件
    logStream.write(`[${timestamp}] [${level.toUpperCase()}]: ${message}\n`);
  };

  // 重写 console.log
  console.log = (...args: any[]) => {
    writeLog('log', args);
    consoleLog(...args); // 保留原始行为
  };

  // 重写 console.error
  console.error = (...args: any[]) => {
    writeLog('error', args);
    consoleError(...args);
  };

  // 重写 console.warn
  console.warn = (...args: any[]) => {
    writeLog('warn', args);
    consoleWarn(...args);
  };

  // 重写 console.info
  console.info = (...args: any[]) => {
    writeLog('info', args);
    consoleInfo(...args);
  };
}
