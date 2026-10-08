#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
\getenv db_password JAP_DB_PASSWORD
CREATE ROLE jgw_approval LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 30;
SELECT format('ALTER ROLE jgw_approval PASSWORD %L', :'db_password') \gexec
ALTER ROLE jgw_approval SET statement_timeout = '5s';
ALTER ROLE jgw_approval SET timezone = 'UTC';
CREATE DATABASE jgw_approval OWNER jgw_approval;
CREATE ROLE jgw_other LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
SELECT format('ALTER ROLE jgw_other PASSWORD %L', :'db_password') \gexec
CREATE DATABASE jgw_other OWNER jgw_other;
REVOKE CONNECT, TEMPORARY ON DATABASE postgres, template1, jgw_approval, jgw_other FROM PUBLIC;
GRANT CONNECT ON DATABASE jgw_approval TO jgw_approval;
GRANT CONNECT ON DATABASE jgw_other TO jgw_other;
SQL
