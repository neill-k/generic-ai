---
"@generic-ai/plugin-auth-identity": minor
---

Rotate owner sessions around sensitive changes: sign-in revokes any session the browser already held, adding or removing a passkey rotates the caller's cookie, and the new `POST /auth/sessions/revoke-others` route (with a button on the login page) signs out every other session.
