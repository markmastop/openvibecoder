# Build experiment: small HR backend

Create only `app.mjs` in the designated candidate directory. Use Node.js 22 ES modules and built-in features only. Do not install packages, start an HTTP server, use network services, write tests or a reference implementation, or modify the supplied acceptance suite.

This bounded experiment tests sign-in, role permissions, leave requests, balances, and persistence. No screens, Supabase connection, or CRM API are required.

## Calling contract

Export `createApp({ storageFile })`. The caller supplies an absolute storage file path. Return an object with `fetch(request)`, accepting a standard `Request` and returning `Promise<Response>`. Every response, including errors, must contain JSON with `Content-Type: application/json`.

Use only the supplied storage file for persistent app data; create its parent directory if necessary. A missing file means a fresh app. Calling `createApp` again with the same path must preserve requests, statuses, and balances. Users may sign in again after reloading; old session tokens do not have to survive. Persist completed changes before `fetch` returns.

## Fixed fictional accounts

| Username | Password | Domain ID | Role | Team | Starting balance |
| --- | --- | --- | --- | --- | --- |
| `user-a` | `oefen-a` | `emp-a` | `employee` | `team-alpha` | 40 hours |
| `user-b` | `oefen-b` | `emp-b` | `employee` | `team-beta` | 40 hours |
| `manager-a` | `oefen-ma` | `manager-a` | `manager` | `team-alpha` | 0 hours |
| `manager-b` | `oefen-mb` | `manager-b` | `manager` | `team-beta` | 0 hours |

These are public test credentials. Do not use real accounts or keys. Derive identity, role, and team on the server from a valid session token. Arbitrary or corrupted tokens must not grant access.

## Routes

| Method and path | Behavior and response |
| --- | --- |
| `POST /login` | JSON `{ "username": "user-a", "password": "oefen-a" }`. Valid credentials return `200` with `{ "token": "non-empty-string" }`. Incorrect credentials return `401`; missing fields, incorrect types, or invalid JSON return `400`. |
| `GET /me` | Requires `Authorization: Bearer <token>`. Returns `200` with `{ "id": "emp-a", "role": "employee", "balanceHours": 40 }`. Use the account's domain ID. |
| `GET /requests` | Returns `200` with `{ "requests": [...] }`. Employees see only their own requests; managers see requests from their own team's employees only. |
| `POST /requests` | Employees only. JSON `{ "hours": 8 }` creates a unique `pending` request. Returns `201` with `{ "request": { "id": "unique-string", "employeeId": "emp-a", "hours": 8, "status": "pending" } }`. |
| `GET /requests/:id` | Returns `200` with `{ "request": { ... } }` for the owner or their team's manager. Others receive `403` or `404`. |
| `POST /requests/:id/approve` | Only the owner's team manager may approve. First successful approval returns `200` with `{ "request": { ... , "status": "approved" } }`. Deduct the employee's balance exactly once. |

All routes except `/login` require a valid bearer token. Missing, arbitrary, or corrupted tokens return `401`. Employees attempting approval receive `403`, even for their own request. Managers from another team receive `403` or `404`. Return a JSON error object such as `{ "error": "Access denied" }`; exact error wording is unrestricted.

## Business rules and negative cases

- `hours` is required, must be a number, and must be a positive integer multiple of **8**. Valid: 8, 16, 24. Invalid: 0, -8, 4, 12, 7.5, `"8"`, `null`, or a missing value. Invalid input returns `400` without changing requests or balances.
- Derive ownership only from the signed-in employee. Ignore additional `employeeId`, `role`, `id`, or `status` fields; they must not alter identity, permissions, or status.
- Pending requests do not deduct or reserve hours.
- Balances must never become negative. A request exceeding the balance may return `409` on creation or become pending and return `409` on approval. Failed approval must leave status and balance unchanged.
- Repeated approval of an approved request returns either `409` or an idempotent `200` with the same approved request. Never deduct again.
- Two concurrent approvals for the same request must cause at most one deduction. At least one returns `200`; the other returns `200` or `409`.
- Persist at least `id`, `employeeId`, `hours`, and `status` for every request. IDs are unique, non-empty strings; the ID generation strategy is unrestricted.

Check the implementation against this contract. Return the working module without extra dependencies or acceptance-test changes.
