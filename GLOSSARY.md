# Holo-JS

Holo-JS integrates application capabilities with a selected web framework.

## Language

**Framework run**:
An execution of the application's selected web framework under `holo dev` or `holo start`.
_Avoid_: Application runtime

**Framework restart**:
Replacement of the active development framework run with another run.

**Framework shutdown**:
Termination of a framework run without replacement.

**Framework preparation**:
Preparation of project artifacts and framework tooling before a framework run.

**Discovery watch**:
Observation of application paths that trigger framework preparation during development.

**Declared schema**:
The tables and attributes an application describes for use, including tables that have not yet been created.

**Database schema**:
The tables and attributes that currently exist in a connected database.

**Auth token redemption**:
The single-use authorization of an email verification or password reset by a valid token.

**Personal access token**:
A reusable credential for authenticating requests as a user, optionally restricted by abilities and expiry. A user may hold multiple independent personal access tokens.

**Browser session**:
The authenticated and application state associated with a browser's session credential. Different browsers or devices may hold independent sessions for the same user.

**Other-device logout**:
Developer-invoked revocation of a user's other browser authentication while retaining the current browser's authentication. Personal access token revocation is a separate operation.

**Authenticated session transition**:
A change to a browser session's authenticated identities during login, multi-factor authentication, impersonation, or logout.

**Managed capability**:
An optional application capability whose resources Holo owns for the duration of its use.

**Reserved job**:
A Queue job acquired by a worker for an execution attempt.

**Job finalization**:
The acknowledgement, release, or terminal failure of a reserved job following its execution attempt.

**Media mutation**:
An attachment, regeneration, or deletion that changes a Media record and its stored files.

**Presence membership**:
The members currently represented in a Flux presence channel.
