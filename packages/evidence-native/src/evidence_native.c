// Stonehush evidence publication native boundary.
//
// Exposes exactly three descriptor-relative operations that Node's public fs
// API cannot express: openat(2), renameat2(2) with RENAME_NOREPLACE, and a
// read-only enumeration of one open directory (dup + fdopendir/readdir).
// No policy lives here. Callers pass pre-validated single path segments and
// directory descriptors; errno is returned as data so TypeScript maps it to
// the ADR-0003 fail-closed error codes.
#define NAPI_VERSION 8
#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <node_api.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

#define MAX_SEGMENT_BYTES 256

static napi_value make_ok_fd(napi_env env, int fd) {
  napi_value result, value;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_get_boolean(env, true, &value) != napi_ok ||
      napi_set_named_property(env, result, "ok", value) != napi_ok ||
      napi_create_int32(env, fd, &value) != napi_ok ||
      napi_set_named_property(env, result, "fd", value) != napi_ok) {
    return NULL;
  }
  return result;
}

static napi_value make_errno_result(napi_env env, bool ok, int err) {
  napi_value result, value;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_get_boolean(env, ok, &value) != napi_ok ||
      napi_set_named_property(env, result, "ok", value) != napi_ok ||
      napi_create_int32(env, err, &value) != napi_ok ||
      napi_set_named_property(env, result, "errno", value) != napi_ok) {
    return NULL;
  }
  return result;
}

static napi_value throw_argument_error(napi_env env, const char* message) {
  napi_value code, error;
  if (napi_create_string_utf8(env, "ERR_INVALID_ARG_VALUE", NAPI_AUTO_LENGTH, &code) != napi_ok ||
      napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &error) != napi_ok) {
    return NULL;
  }
  napi_value exception;
  if (napi_create_type_error(env, code, error, &exception) != napi_ok) return NULL;
  napi_throw(env, exception);
  return NULL;
}

// Reads one string argument and rejects anything that cannot be a single
// relative path segment: empty, too long, containing NUL or '/'.
static int read_segment(napi_env env, napi_value value, char* out, size_t out_size) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return -1;
  if (length == 0 || length >= out_size) return -1;
  if (napi_get_value_string_utf8(env, value, out, out_size, &length) != napi_ok) return -1;
  if (length == 0) return -1;
  // Embedded NUL would truncate the segment; the terminator at out[length]
  // is expected and excluded here.
  if (memchr(out, '\0', length) != NULL) return -1;
  for (size_t index = 0; index < length; index += 1) {
    if (out[index] == '/') return -1;
  }
  // Reject "." and ".." outright: relative-parent traversal is never a
  // legitimate managed-tree name.
  if (out[0] == '.' && (length == 1 || (length == 2 && out[1] == '.'))) return -1;
  return 0;
}

static napi_value open_at(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 4) {
    return throw_argument_error(env, "openAt requires (dirfd, name, flags, mode)");
  }

  int32_t dirfd = 0;
  int32_t flags = 0;
  int32_t mode = 0;
  char name[MAX_SEGMENT_BYTES];
  if (napi_get_value_int32(env, argv[0], &dirfd) != napi_ok ||
      read_segment(env, argv[1], name, sizeof(name)) != 0 ||
      napi_get_value_int32(env, argv[2], &flags) != napi_ok ||
      napi_get_value_int32(env, argv[3], &mode) != napi_ok) {
    return throw_argument_error(env, "openAt arguments must be (int fd, short relative segment, int flags, int mode)");
  }

  int fd = openat((int)dirfd, name, (int)flags, (mode_t)mode);
  if (fd < 0) return make_errno_result(env, false, errno);
  return make_ok_fd(env, fd);
}

static napi_value make_ok_names(napi_env env, char** names, size_t count) {
  napi_value result, value, array;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_get_boolean(env, true, &value) != napi_ok ||
      napi_set_named_property(env, result, "ok", value) != napi_ok ||
      napi_create_array_with_length(env, count, &array) != napi_ok) {
    return NULL;
  }
  for (size_t index = 0; index < count; index += 1) {
    napi_value name;
    if (napi_create_string_utf8(env, names[index], NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_set_element(env, array, (uint32_t)index, name) != napi_ok) {
      return NULL;
    }
  }
  if (napi_set_named_property(env, result, "names", array) != napi_ok) return NULL;
  return result;
}

// Enumerates one open directory without touching any path. The caller's
// descriptor is duplicated so the DIR stream owns its own descriptor and
// closedir() can never consume the startup fd. Returned names are plain
// entries: every name is still opened by the caller with openat(O_NOFOLLOW)
// and fstat before it is trusted.
static napi_value read_dir_names(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t dirfd = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1 ||
      napi_get_value_int32(env, argv[0], &dirfd) != napi_ok) {
    return throw_argument_error(env, "readDirNames requires (int dirfd)");
  }

  int fd = dup((int)dirfd);
  if (fd < 0) return make_errno_result(env, false, errno);
  DIR* directory = fdopendir(fd);
  if (directory == NULL) {
    int saved_errno = errno;
    close(fd);
    return make_errno_result(env, false, saved_errno);
  }

  char** names = NULL;
  size_t count = 0;
  size_t capacity = 0;
  int failure = 0;
  int read_errno = 0;
  struct dirent* entry;
  for (;;) {
    // Canonical end-of-directory detection: errno must be cleared before
    // every call so a NULL return with errno != 0 really is an error.
    errno = 0;
    entry = readdir(directory);
    if (entry == NULL) {
      read_errno = errno;
      break;
    }
    const char* name = entry->d_name;
    // readdir yields "." and ".." on every directory; they are not tree
    // entries and must never reach the caller.
    if (name[0] == '.' && (name[1] == '\0' || (name[1] == '.' && name[2] == '\0'))) continue;
    if (count == capacity) {
      size_t grown = capacity == 0 ? 16 : capacity * 2;
      char** resized = realloc(names, grown * sizeof(*names));
      if (resized == NULL) {
        failure = ENOMEM;
        break;
      }
      names = resized;
      capacity = grown;
    }
    char* copied = strdup(name);
    if (copied == NULL) {
      failure = ENOMEM;
      break;
    }
    names[count] = copied;
    count += 1;
  }
  if (failure == 0 && read_errno != 0) failure = read_errno;
  if (closedir(directory) != 0 && failure == 0) failure = errno;

  napi_value result = NULL;
  if (failure != 0) {
    result = make_errno_result(env, false, failure);
  } else {
    result = make_ok_names(env, names, count);
  }
  for (size_t index = 0; index < count; index += 1) free(names[index]);
  free(names);
  return result;
}

static napi_value rename_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 4) {
    return throw_argument_error(env, "renameNoReplace requires (oldDirfd, oldName, newDirfd, newName)");
  }

  int32_t old_dirfd = 0;
  int32_t new_dirfd = 0;
  char old_name[MAX_SEGMENT_BYTES];
  char new_name[MAX_SEGMENT_BYTES];
  if (napi_get_value_int32(env, argv[0], &old_dirfd) != napi_ok ||
      read_segment(env, argv[1], old_name, sizeof(old_name)) != 0 ||
      napi_get_value_int32(env, argv[2], &new_dirfd) != napi_ok ||
      read_segment(env, argv[3], new_name, sizeof(new_name)) != 0) {
    return throw_argument_error(env, "renameNoReplace arguments must be (int dirfd, short relative segment, int dirfd, short relative segment)");
  }

  if (renameat2((int)old_dirfd, old_name, (int)new_dirfd, new_name, RENAME_NOREPLACE) != 0) {
    return make_errno_result(env, false, errno);
  }
  return make_errno_result(env, true, 0);
}

// The single advisory-flock operation exposed to TypeScript. Acquire
// operations must be LOCK_SH or LOCK_EX and always run nonblocking, so a
// held lock surfaces as EWOULDBLOCK errno data instead of blocking the agent
// loop; LOCK_UN releases whatever this open file description holds.
static napi_value flock_nonblock(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 2) {
    return throw_argument_error(env, "flockNonblock requires (fd, operation)");
  }

  int32_t fd = 0;
  int32_t operation = 0;
  if (napi_get_value_int32(env, argv[0], &fd) != napi_ok ||
      napi_get_value_int32(env, argv[1], &operation) != napi_ok) {
    return throw_argument_error(env, "flockNonblock arguments must be (int fd, int operation)");
  }
  if (operation != LOCK_SH && operation != LOCK_EX && operation != LOCK_UN) {
    return throw_argument_error(
      env,
      "flockNonblock operation must be LOCK_SH, LOCK_EX, or LOCK_UN");
  }

  const int flags = operation == LOCK_UN ? operation : operation | LOCK_NB;
  if (flock((int)fd, flags) != 0) {
    return make_errno_result(env, false, errno);
  }
  return make_errno_result(env, true, 0);
}

static napi_value create_function(napi_env env, const char* name, napi_callback callback) {
  napi_value function;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL, &function) != napi_ok) {
    return NULL;
  }
  return function;
}

NAPI_MODULE_INIT() {
  napi_value open_at_function = create_function(env, "openAt", open_at);
  napi_value rename_function = create_function(env, "renameNoReplace", rename_no_replace);
  napi_value read_dir_function = create_function(env, "readDirNames", read_dir_names);
  napi_value flock_function = create_function(env, "flockNonblock", flock_nonblock);
  if (open_at_function == NULL || rename_function == NULL || read_dir_function == NULL ||
      flock_function == NULL) {
    return NULL;
  }
  if (napi_set_named_property(env, exports, "openAt", open_at_function) != napi_ok ||
      napi_set_named_property(env, exports, "renameNoReplace", rename_function) != napi_ok ||
      napi_set_named_property(env, exports, "readDirNames", read_dir_function) != napi_ok ||
      napi_set_named_property(env, exports, "flockNonblock", flock_function) != napi_ok) {
    return NULL;
  }
  return exports;
}
