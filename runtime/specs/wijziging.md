# Change experiment: half-day leave

Update the existing `app.mjs`. The baseline contract still applies, with exactly one changed business rule:

**New leave requests may use any positive integer multiple of 4 hours.**

- 4, 8, 12, 16, and 24 hours are valid.
- 0, negative numbers, fractions, 2, 6, `"4"`, `null`, and missing hours remain invalid and return `400`.
- Existing eight-hour requests and their persistence must keep working.
- Preserve sign-in, derived ownership, team permissions, balance deduction only on approval, protection against duplicate deductions, and persistence.

Do not change routes, account credentials, response fields, or the export contract. Do not add dependencies. Edit only the candidate module; leave acceptance tests unchanged. Check both the new input rule and existing behavior.
