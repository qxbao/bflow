# Refactor: shared validation

Extract safe integer input validation to a private helper. Preserve current
observable behavior, including the known output-overflow behavior until separately
fixed. Run the unchanged suite before/after; independent review must inspect the
diff. Resolver default is `recommended`; successful alternative verification is
still required. Do not combine this exercise with the feature/bugfix exercise.
