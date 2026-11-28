// 模拟持久文件内容和持久目录项的两个独立屏障，不模拟硬件写缓存或真实断电。
export class SnapshotFs {
  constructor() {
    this.names = new Map(); this.durableNames = new Map(); this.inodes = new Map();
    this.dirs = new Set(['/']); this.fds = new Map(); this.seq = 0; this.fdSeq = 10;
    this.failDirectorySync = false;
  }
  existsSync(p) { return this.names.has(p) || this.dirs.has(p); }
  mkdirSync(p) { for (let cursor = p; cursor !== '/'; cursor = cursor.slice(0, cursor.lastIndexOf('/')) || '/') this.dirs.add(cursor); }
  openSync(p, flags) {
    let inode = this.names.get(p);
    if (flags.includes('w')) {
      if (flags.includes('x') && inode) throw Object.assign(new Error('文件已存在'), { code: 'EEXIST' });
      inode = ++this.seq; this.names.set(p, inode);
      this.inodes.set(inode, { bytes: Buffer.alloc(0), durable: Buffer.alloc(0) });
    }
    if (!inode && !this.dirs.has(p)) throw Object.assign(new Error('文件不存在'), { code: 'ENOENT' });
    const fd = ++this.fdSeq; this.fds.set(fd, { p, inode }); return fd;
  }
  writeFileSync(fd, data) { this.inodes.get(this.fds.get(fd).inode).bytes = Buffer.from(data); }
  readFileSync(p, encoding) {
    const inode = this.inodes.get(this.names.get(p));
    if (!inode) throw Object.assign(new Error('文件不存在'), { code: 'ENOENT' });
    return encoding ? inode.bytes.toString(encoding) : Buffer.from(inode.bytes);
  }
  fsyncSync(fd) {
    const { inode } = this.fds.get(fd);
    if (inode) this.inodes.get(inode).durable = Buffer.from(this.inodes.get(inode).bytes);
    else {
      if (this.failDirectorySync) throw Object.assign(new Error('目录同步故障'), { code: 'EIO' });
      this.durableNames = new Map(this.names);
    }
  }
  closeSync(fd) { this.fds.delete(fd); }
  renameSync(from, to) { this.names.set(to, this.names.get(from)); this.names.delete(from); }
  unlinkSync(p) { this.names.delete(p); }
  statSync(p, options = {}) {
    const inode = this.inodes.get(this.names.get(p));
    if (!inode) {
      if (options.throwIfNoEntry === false) return undefined;
      throw Object.assign(new Error('文件不存在'), { code: 'ENOENT' });
    }
    return { size: inode.bytes.length };
  }
  readdirSync(p) {
    const prefix = p === '/' ? '/' : p + '/';
    const out = new Set();
    for (const name of this.names.keys()) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      if (rest.length > 0 && !rest.includes('/')) out.add(rest);
    }
    for (const dir of this.dirs) {
      if (!dir.startsWith(prefix) || dir === p) continue;
      const rest = dir.slice(prefix.length);
      if (rest.length > 0 && !rest.includes('/')) out.add(rest);
    }
    return Array.from(out);
  }
  crash() {
    this.names = new Map(this.durableNames); this.fds.clear();
    for (const inode of this.inodes.values()) inode.bytes = Buffer.from(inode.durable);
  }
}
