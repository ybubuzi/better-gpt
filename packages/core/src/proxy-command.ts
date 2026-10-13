import { connect } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { SocksClient } from 'socks';

const host = process.argv[2], port = Number(process.argv[3]);
async function main() {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH代理目标无效');
  const url = new URL(process.env.BETTER_GPT_SSH_PROXY ?? '');
  let socket;
  if (/^socks[45]/.test(url.protocol)) {
    const result = await SocksClient.createConnection({ command: 'connect', destination: { host, port }, timeout: 15000,
      proxy: { host: url.hostname, port: Number(url.port || 1080), type: url.protocol.startsWith('socks4') ? 4 : 5,
        ...(url.username ? { userId: decodeURIComponent(url.username) } : {}), ...(url.password ? { password: decodeURIComponent(url.password) } : {}) } });
    socket = result.socket;
  } else if (url.protocol === 'http:' || url.protocol === 'https:') {
    socket = url.protocol === 'https:' ? connectTls({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname }) : connect({ host: url.hostname, port: Number(url.port || 80) });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => socket!.destroy(new Error('代理连接超时')), 15000); socket!.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(); }); socket!.once('error', (error: Error) => { clearTimeout(timer); reject(error); }); });
    const authorization = url.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}\r\n` : '';
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${authorization}\r\n`);
    await new Promise<void>((resolve, reject) => {
      let buffer = Buffer.alloc(0); const timer = setTimeout(() => { socket!.destroy(); reject(new Error('HTTP代理连接超时')); }, 15000);
      const read = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 65536) { clearTimeout(timer); reject(new Error('HTTP代理响应过大')); socket!.destroy(); return; }
        const index = buffer.indexOf('\r\n\r\n'); if (index < 0) return;
        clearTimeout(timer); socket!.off('data', read);
        if (!/^HTTP\/1\.[01] 200\b/.test(buffer.toString('ascii', 0, index))) { reject(new Error('HTTP代理拒绝CONNECT')); socket!.destroy(); return; }
        socket!.pause(); const remainder = buffer.subarray(index + 4); if (remainder.length) socket!.unshift(remainder); resolve();
      };
      socket!.on('data', read); socket!.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
    });
  } else throw new Error('不支持的SSH代理协议');
  socket.on('error', () => { process.exitCode = 1; process.stdin.destroy(); });
  socket.on('close', () => process.stdin.destroy());
  process.stdin.pipe(socket); socket.pipe(process.stdout); socket.resume();
}
main().catch(() => { process.stderr.write('SSH代理连接失败\n'); process.exitCode = 1; });
