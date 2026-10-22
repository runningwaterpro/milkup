/**
 * 主进程的输出流守卫。
 *
 * 应用可能被启动器用管道拉起，启动器一关，stdout 的读端就没了。
 * 这时主进程再写日志，Node 会抛出 EPIPE；没人监听 error 事件的话，
 * 整个主进程会带着这个异常退出。日志写不出去不是致命错误，不能因此崩掉应用。
 */

interface OutputStream {
  on: (event: "error", listener: (error: NodeJS.ErrnoException) => void) => unknown;
}

/**
 * 给输出流装上守卫：管道关闭（EPIPE）时忽略，其它错误照常抛。
 */
export function installOutputStreamGuards(
  streams: OutputStream[] = [process.stdout, process.stderr]
): void {
  for (const stream of streams) {
    stream.on("error", (error) => {
      if (error.code === "EPIPE") return;
      throw error;
    });
  }
}
