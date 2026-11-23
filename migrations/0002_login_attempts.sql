CREATE TABLE login_attempts (
    client INET PRIMARY KEY,
    expires TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL
);
CREATE INDEX login_attempts_expiry ON login_attempts (expires);
