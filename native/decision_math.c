#include <errno.h>
#include <locale.h>
#ifdef __APPLE__
#include <xlocale.h>
#else
/* Bend may include libc headers before this fragment's feature macros. */
extern double strtod_l(const char *, char **, locale_t);
#endif
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Trusted, bounded, subprocess-free double arithmetic. No provider parsing,
 * transport, clock, files, environment, or model execution lives here.
 * The Bend wrapper bounds UTF-32 input before io_cstr allocates its copy.
 * All JSON input/output is independently checked by Codec on the Bend side.
 */
static int jdm_number(const char *s, size_t n, locale_t loc, double *value) {
  if (!n || n > 1024 || memchr(s, 0, n)) return 0;
  size_t i = 0;
  if (s[i] == '-') ++i;
  if (i == n) return 0;
  if (s[i] == '0') ++i;
  else {
    if (s[i] < '1' || s[i] > '9') return 0;
    while (i < n && s[i] >= '0' && s[i] <= '9') ++i;
  }
  if (i < n && s[i] == '.') {
    size_t start = ++i;
    while (i < n && s[i] >= '0' && s[i] <= '9') ++i;
    if (start == i) return 0;
  }
  if (i < n && (s[i] == 'e' || s[i] == 'E')) {
    ++i;
    if (i < n && (s[i] == '+' || s[i] == '-')) ++i;
    size_t start = i;
    while (i < n && s[i] >= '0' && s[i] <= '9') ++i;
    if (start == i) return 0;
  }
  if (i != n) return 0;
  char copy[1025], *end;
  memcpy(copy, s, n); copy[n] = 0;
  *value = strtod_l(copy, &end, loc);
  return end == copy + n && isfinite(*value);
}

/* Positive logprobs are invalid even if decimal-to-double underflows to zero. */
static int jdm_nonzero_mantissa(const char *s, size_t n) {
  for (size_t i = 0; i < n && s[i] != 'e' && s[i] != 'E'; ++i)
    if (s[i] >= '1' && s[i] <= '9') return 1;
  return 0;
}

/* %.17g is a double lexical roundtrip, never a six-digit/F32 rendering.
 * A host with a non-dot printf locale fails closed; no global locale mutation.
 */
static int jdm_emit(char *out, size_t cap, size_t *used, double value, locale_t loc) {
  if (!isfinite(value) || *used >= cap) return 0;
  int n = snprintf(out + *used, cap - *used, "%.17g", value == 0 ? 0.0 : value);
  double back;
  if (n < 1 || (size_t)n >= cap - *used ||
      !jdm_number(out + *used, (size_t)n, loc, &back) || back != value) return 0;
  *used += (size_t)n;
  return 1;
}

static int jdm_compute(const char *temp, size_t tn, const char *input, size_t len,
                       char *out, size_t cap) {
  if (tn > 1024 || len > 63550 || cap < 8192) return 0;
  locale_t loc = newlocale(LC_NUMERIC_MASK, "C", (locale_t)0);
  if (!loc) return 0;
  int ok = 0;
  double t, values[62], weights[62], peak = -INFINITY, total = 0, score = 0;
  size_t count = 0, offset = 0, best = 0, used = 0;
  if (!jdm_number(temp, tn, loc, &t) || !(t > 0)) goto done;
  if (len == 0) { strcpy(out, "{}"); ok = 1; goto done; }
  while (offset < len) {
    if (count == 62) goto done;
    const char *nl = memchr(input + offset, '\n', len - offset);
    size_t n = nl ? (size_t)(nl - input - offset) : len - offset;
    if (!jdm_number(input + offset, n, loc, &values[count]) || values[count] > 0 ||
        (input[offset] != '-' && jdm_nonzero_mantissa(input + offset, n))) goto done;
    if (values[count] > peak) { peak = values[count]; best = count; }
    ++count;
    offset += n + (nl != NULL);
    if (nl && offset == len) goto done;
  }
  if (count < 2 || peak <= -1e30) goto done;
  for (size_t i = 0; i < count; ++i) {
    /* Subtract BEFORE dividing: finite inputs / tiny t must not overflow
     * the maximum. A negative-infinite tail has exactly zero double weight. */
    double scaled = (values[i] - peak) / t;
    if (isnan(scaled) || scaled > 0) goto done;
    weights[i] = isinf(scaled) ? 0 : exp(scaled);
    if (!isfinite(weights[i])) goto done;
    total += weights[i];
  }
  if (!isfinite(total) || total <= 0) goto done;
  memcpy(out, "{\"probabilities\":[", 18); used = 18;
  for (size_t i = 0; i < count; ++i) {
    double p = weights[i] / total;
    score += (double)i * p;
    if (i) out[used++] = ',';
    if (!jdm_emit(out, cap, &used, p, loc)) goto done;
  }
  double confidence = fmin(1, fmax(0, ((double)count * weights[best] / total - 1) / (double)(count - 1)));
  int n = snprintf(out + used, cap - used, "],\"best\":%zu,\"confidence\":", best);
  if (n < 0 || (size_t)n >= cap - used) goto done;
  used += (size_t)n;
  if (!jdm_emit(out, cap, &used, confidence, loc)) goto done;
  memcpy(out + used, ",\"score\":", 9); used += 9;
  if (!jdm_emit(out, cap, &used, score, loc)) goto done;
  out[used++] = '}'; out[used] = 0;
  ok = 1;
done:
  freelocale(loc);
  return ok;
}

static Term jdm_statistics_run(Env e, Term *f, IoWork *w) {
  (void)w;
  u64 tn = 0, vn = 0;
  char *t = io_cstr(e, f[0], &tn), *v = io_cstr(e, f[1], &vn), out[8192];
  int ok = t && v && jdm_compute(t, tn, v, vn, out, sizeof(out));
  free(t); free(v);
  if (!ok) return io_fail(e, 22, "invalid/nonfinite local probability statistics");
  return io_done(e, io_str(e, out, strlen(out)));
}

static void __attribute__((constructor)) jdm_statistics_use(void) {
  io_eff(CID(Native.statistics), jdm_statistics_run);
}
