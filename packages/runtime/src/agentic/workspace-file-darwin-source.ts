/** Owned helper, compiled by Apple's system clang; no downloaded code or Node ABI dependency.
 * openat pins each directory and O_NOFOLLOW rejects replacement symlinks at the actual open.
 * stdin/stdout carry bounded raw bytes, never commands. CommonCrypto is part of macOS libSystem.
 * See Apple's open(2), fcntl(2) and CommonCrypto/CommonDigest.h. */
export const workspaceFileDarwinSource = String.raw`
#include <sys/stat.h>
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <CommonCrypto/CommonDigest.h>
#define LIMIT 131072
_Noreturn static void fail(const char *message) { fprintf(stderr, "%s\n", message); exit(1); }
static void utf8(const unsigned char *bytes, size_t length) {
  for (size_t i = 0; i < length;) {
    unsigned int c = bytes[i++], value, minimum; int remaining;
    if (c < 0x80) continue;
    if (c >= 0xc2 && c <= 0xdf) { remaining = 1; value = c & 0x1f; minimum = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { remaining = 2; value = c & 0x0f; minimum = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { remaining = 3; value = c & 7; minimum = 0x10000; }
    else fail("Developer file must be valid UTF-8");
    if (i + (size_t)remaining > length) fail("Developer file must be valid UTF-8");
    while (remaining--) { c = bytes[i++]; if ((c & 0xc0) != 0x80) fail("Developer file must be valid UTF-8"); value = (value << 6) | (c & 0x3f); }
    if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) fail("Developer file must be valid UTF-8");
  }
}
static void digest_matches(const unsigned char *bytes, size_t length, const char *expected) {
  unsigned char sum[CC_SHA256_DIGEST_LENGTH]; char hex[65];
  CC_SHA256(bytes, (CC_LONG)length, sum);
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) snprintf(hex + 2*i, 3, "%02x", sum[i]);
  if (strcmp(hex, expected)) fail("Prior file digest changed; read the file before retrying");
}
static void regular(struct stat *s) {
  if (!S_ISREG(s->st_mode) || s->st_nlink != 1) fail("Developer file access requires a regular file with no hardlinks");
  if (s->st_size > LIMIT) fail("Developer file exceeds 128 KiB");
}
static void path_matches(int fd, const char *expected) {
  char actual[PATH_MAX];
  if (fcntl(fd, F_GETPATH, actual) < 0 || strcmp(actual, expected)) fail("Developer workspace moved during file access");
}
static size_t bounded_read(int fd, unsigned char *bytes) {
  struct stat before, after;
  if (fstat(fd, &before)) fail("Cannot inspect Developer file"); regular(&before);
  size_t length = 0;
  while (length <= LIMIT) {
    ssize_t n = pread(fd, bytes + length, LIMIT + 1 - length, (off_t)length);
    if (n < 0) { if (errno == EINTR) continue; fail("Cannot read Developer file"); }
    if (!n) break; length += (size_t)n;
  }
  if (fstat(fd, &after)) fail("Cannot inspect Developer file"); regular(&after);
  if (length > LIMIT || before.st_size != (off_t)length || after.st_size != (off_t)length ||
      before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
      before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec || before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec)
    fail("Developer file changed during read; inspect before retrying");
  utf8(bytes, length); return length;
}
static int directory(int parent, const char *part) {
  int fd = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail("Developer directory access refused (missing parent or symlink)");
  return fd;
}
int main(int argc, char **argv) {
  if (argc != 5 || (strcmp(argv[1], "read") && strcmp(argv[1], "write"))) fail("Invalid workspace operation");
  const int writing = !strcmp(argv[1], "write"), creating = !strcmp(argv[4], "new");
  if (argv[2][0] != '/' || !argv[3][0] || argv[3][0] == '/' || strlen(argv[2]) >= PATH_MAX || strlen(argv[3]) >= PATH_MAX)
    fail("Invalid workspace path");
  char root[PATH_MAX], local[PATH_MAX], expected[PATH_MAX];
  strcpy(root, argv[2]); strcpy(local, argv[3]); strcpy(expected, argv[2]);
  // Open the absolute canonical root component by component too: O_NOFOLLOW on the final root alone
  // would still follow a swapped ancestor. No pathname-based read/write follows this traversal.
  int rootfd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (rootfd < 0) fail("Cannot open filesystem root");
  char *save = NULL;
  for (char *p = strtok_r(root + 1, "/", &save); p; p = strtok_r(NULL, "/", &save)) {
    if (!strcmp(p, ".") || !strcmp(p, "..")) fail("Invalid workspace root");
    int next = directory(rootfd, p); close(rootfd); rootfd = next;
  }
  path_matches(rootfd, argv[2]);
  int parent = dup(rootfd); if (parent < 0) fail("Cannot pin workspace root");
  char *cursor = local, *leaf;
  for (;;) {
    leaf = strsep(&cursor, "/");
    if (!leaf || !*leaf || !strcmp(leaf, ".") || !strcmp(leaf, "..") || strchr(leaf, '\\')) fail("Invalid workspace component");
    if (!cursor) break;
    if (strlen(expected) + strlen(leaf) + 2 >= PATH_MAX) fail("Workspace path exceeds bound");
    strcat(expected, "/"); strcat(expected, leaf);
    int next = directory(parent, leaf); close(parent); parent = next;
    path_matches(parent, expected);
  }
  path_matches(rootfd, argv[2]); path_matches(parent, expected);
  // lstat-at rejects devices before opening them; fstat after open closes the replacement race.
  struct stat entry;
  if (fstatat(parent, leaf, &entry, AT_SYMLINK_NOFOLLOW)) {
    if (errno != ENOENT) fail("Cannot inspect workspace entry");
    if (!writing) return 3;
    if (!creating) fail("Prior file is missing; read the file before retrying");
  } else {
    regular(&entry);
    if (writing && creating) fail("Exclusive workspace file creation refused: file exists");
  }
  int fd = openat(parent, leaf, (writing ? O_RDWR : O_RDONLY) | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC |
    (writing && creating ? O_CREAT | O_EXCL : 0), 0600);
  if (fd < 0) fail("Developer file open refused");
  if (flock(fd, (writing ? LOCK_EX : LOCK_SH) | LOCK_NB)) fail("Developer file is busy; inspect before retrying");
  unsigned char bytes[LIMIT + 1];
  size_t length = bounded_read(fd, bytes);
  if (writing) {
    if (!creating) digest_matches(bytes, length, argv[4]);
    length = 0;
    while (length <= LIMIT) {
      ssize_t n = read(STDIN_FILENO, bytes + length, LIMIT + 1 - length);
      if (n < 0) { if (errno == EINTR) continue; fail("Cannot read workspace content"); }
      if (!n) break; length += (size_t)n;
    }
    if (length > LIMIT) fail("Developer content exceeds 128 KiB");
    utf8(bytes, length);
    path_matches(rootfd, argv[2]); path_matches(parent, expected);
    struct stat current, opened;
    if (fstat(fd, &opened) || fstatat(parent, leaf, &current, AT_SYMLINK_NOFOLLOW)) fail("Developer file moved during access");
    regular(&opened); regular(&current);
    if (current.st_dev != opened.st_dev || current.st_ino != opened.st_ino) fail("Developer file replaced during access");
    if (creating && opened.st_size != 0) fail("New Developer file changed during access");
    if (!creating) {
      unsigned char original[LIMIT + 1]; size_t current_length = bounded_read(fd, original);
      digest_matches(original, current_length, argv[4]);
    }
    size_t written = 0;
    while (written < length) {
      ssize_t n = pwrite(fd, bytes + written, length - written, (off_t)written);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) fail("Developer file write made no progress");
      written += (size_t)n;
    }
    if (ftruncate(fd, (off_t)length) || fsync(fd)) fail("Cannot persist Developer file");
  } else {
    path_matches(rootfd, argv[2]); path_matches(parent, expected);
    size_t sent = 0;
    while (sent < length) {
      ssize_t n = write(STDOUT_FILENO, bytes + sent, length - sent);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) fail("Cannot return workspace content"); sent += (size_t)n;
    }
  }
  close(fd); close(parent); close(rootfd); return 0;
}
`;
