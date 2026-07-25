/**
 * C source for the window-size shim, kept as a string rather than a `.c` file
 * imported with `type: "text"`. The import attribute works at runtime and
 * survives `bun build --compile`, but it needs an ambient module declaration in
 * every package that typechecks a consumer of this one. A string constant has
 * no such reach.
 *
 * The source is header-free so it compiles on machines without Xcode Command
 * Line Tools or libc development headers.
 *
 * `ioctl` MUST stay declared variadic. On Apple arm64 the trailing argument is
 * passed on the stack, and a fixed-arity declaration silently passes garbage:
 * the request still reaches the kernel (SIGWINCH fires) while the winsize
 * pointer is junk. That is precisely why `bun:ffi` cannot bind ioctl directly.
 */
export const PTY_WINSIZE_SOURCE = `
int ioctl(int, unsigned long, ...);

/* TIOCSWINSZ / TIOCGWINSZ differ per platform, so the caller owns the request
 * constant and this file stays platform-neutral. */
int t4_set_winsize(int fd, unsigned long request, unsigned short rows, unsigned short cols) {
	struct {
		unsigned short row, col, xpixel, ypixel;
	} ws = {rows, cols, 0, 0};
	return ioctl(fd, request, &ws);
}

int t4_get_winsize(int fd, unsigned long request, unsigned short *out) {
	struct {
		unsigned short row, col, xpixel, ypixel;
	} ws = {0, 0, 0, 0};
	int rc = ioctl(fd, request, &ws);
	out[0] = ws.row;
	out[1] = ws.col;
	return rc;
}
`;
