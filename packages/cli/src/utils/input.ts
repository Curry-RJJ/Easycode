/**
 * 终端输入工具函数
 */

/** 密码输入（隐藏字符） */
export async function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let password = '';

    const onData = (chunk: Buffer) => {
      const char = chunk.toString('utf8');

      if (char === '\r' || char === '\n') {
        process.stdout.write('\n');
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
        resolve(password);
      } else if (char === '\x7f' || char === '\b') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\r\x1b[K' + prompt + '*'.repeat(password.length));
        }
      } else if (char === '\x03') {
        process.stdout.write('\n');
        process.exit(0);
      } else {
        password += char;
        process.stdout.write('*');
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}
