# Bugfix: overflowing sum

`sum(Number.MAX_SAFE_INTEGER, 1)` currently returns an unsafe integer. The accepted
behavior for this exercise is to throw `RangeError`. First capture the missing
regression test failing on the existing implementation; preserve existing tests.
Use criterion `bugfix-1` in the bugfix seed. The baseline suite passes because it
does not yet contain that regression test. This is an intentional exercise defect.
