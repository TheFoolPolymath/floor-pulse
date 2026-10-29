-- Floor Pulse database schema (MySQL 8 / TiDB). Apply with:  npm run db:migrate
-- Safe to run again. Google Sheets keeps only: Attendance, KPI_MIS (logins), Calls_MIS (calls),
-- Efficiency_Log and Audit_Log. Everything else lives in these tables.

-- Telecallers and team leaders. One row per person. Never delete: status LEFT keeps the history.
CREATE TABLE IF NOT EXISTS employees (
  emp_code VARCHAR(20) NOT NULL PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  team_id VARCHAR(20) NOT NULL,
  team_name VARCHAR(60) NOT NULL DEFAULT '',
  leader_code VARCHAR(20) NOT NULL DEFAULT '',
  role VARCHAR(12) NOT NULL,              -- TELECALLER or TL
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE, PROBATION, NOTICE, LEFT
  join_date DATE NULL,
  exit_date DATE NULL
);
CREATE INDEX idx_employees_team ON employees (team_id);

-- Who may sign in, with Google. One row per email (Gmail dots and +tags ignored).
CREATE TABLE IF NOT EXISTS access_users (
  email_key VARCHAR(190) NOT NULL PRIMARY KEY,
  email VARCHAR(190) NOT NULL,
  name VARCHAR(80) NOT NULL DEFAULT '',
  role VARCHAR(10) NOT NULL,              -- ADMIN or TL
  team_id VARCHAR(20) NOT NULL DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE or REVOKED
  added_on DATE NULL
);

-- Targets and shift settings (key / value).
CREATE TABLE IF NOT EXISTS app_config (
  config_key VARCHAR(60) NOT NULL PRIMARY KEY,
  config_value DECIMAL(14,4) NOT NULL,
  note VARCHAR(255) NOT NULL DEFAULT ''
);

-- Names as the backend team types them, when they do not match Employees by themselves.
CREATE TABLE IF NOT EXISTS name_map (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tc_name VARCHAR(80) NOT NULL,
  tl_name VARCHAR(80) NOT NULL DEFAULT '',
  emp_code VARCHAR(20) NOT NULL
);

-- Rows of the backend sheet that could not be used. Rewritten on every sync.
CREATE TABLE IF NOT EXISTS import_issues (
  id INT AUTO_INCREMENT PRIMARY KEY,
  when_at VARCHAR(20) NOT NULL DEFAULT '',
  issue_type VARCHAR(40) NOT NULL DEFAULT '',
  issue_date VARCHAR(10) NOT NULL DEFAULT '',
  tc_name VARCHAR(80) NOT NULL DEFAULT '',
  tl_name VARCHAR(80) NOT NULL DEFAULT '',
  customer VARCHAR(80) NOT NULL DEFAULT '',
  detail VARCHAR(500) NOT NULL DEFAULT '',
  sheet_row VARCHAR(120) NOT NULL DEFAULT ''
);

-- Personal, bank and job details. PAN, Aadhaar and account number are AES-256-GCM encrypted (see DATA_KEY).
CREATE TABLE IF NOT EXISTS directory (
  emp_code VARCHAR(20) NOT NULL PRIMARY KEY,
  full_name VARCHAR(80) NOT NULL DEFAULT '',
  dob DATE NULL,
  gender VARCHAR(10) NOT NULL DEFAULT '',
  marital_status VARCHAR(12) NOT NULL DEFAULT '',
  blood_group VARCHAR(4) NOT NULL DEFAULT '',
  father_name VARCHAR(80) NOT NULL DEFAULT '',
  mother_name VARCHAR(80) NOT NULL DEFAULT '',
  emergency_name VARCHAR(80) NOT NULL DEFAULT '',
  emergency_phone VARCHAR(12) NOT NULL DEFAULT '',
  address VARCHAR(250) NOT NULL DEFAULT '',
  mobile VARCHAR(12) NOT NULL DEFAULT '',
  email VARCHAR(120) NOT NULL DEFAULT '',
  pan_enc VARCHAR(255) NOT NULL DEFAULT '',
  aadhaar_enc VARCHAR(255) NOT NULL DEFAULT '',
  bank_name VARCHAR(60) NOT NULL DEFAULT '',
  account_holder VARCHAR(80) NOT NULL DEFAULT '',
  account_no_enc VARCHAR(255) NOT NULL DEFAULT '',
  ifsc VARCHAR(15) NOT NULL DEFAULT '',
  bank_branch VARCHAR(80) NOT NULL DEFAULT '',
  designation VARCHAR(60) NOT NULL DEFAULT '',
  salary DECIMAL(12,2) NULL,
  updated_on DATE NULL,
  updated_by VARCHAR(190) NOT NULL DEFAULT ''
);

-- Monthly rupee targets. scope EMP (target_id = emp_code) or TEAM (target_id = team_id).
CREATE TABLE IF NOT EXISTS targets (
  scope VARCHAR(4) NOT NULL,
  target_id VARCHAR(20) NOT NULL,
  target_month CHAR(7) NOT NULL,          -- 2026-10
  target_amount DECIMAL(14,2) NOT NULL,
  set_by VARCHAR(190) NOT NULL DEFAULT '',
  set_on DATE NULL,
  PRIMARY KEY (scope, target_id, target_month)
);

-- Behaviour remarks (admin only). status VOID = withdrawn, never deleted.
CREATE TABLE IF NOT EXISTS remarks (
  remark_id VARCHAR(40) NOT NULL PRIMARY KEY,
  remark_date DATE NOT NULL,
  emp_code VARCHAR(20) NOT NULL,
  category VARCHAR(80) NOT NULL,
  note VARCHAR(300) NOT NULL DEFAULT '',
  given_by VARCHAR(190) NOT NULL DEFAULT '',
  created_at VARCHAR(20) NOT NULL DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE'
);
CREATE INDEX idx_remarks_emp ON remarks (emp_code);

-- Customer cases. source BACKEND rows are rewritten from the backend sheet; APP rows are typed in the app.
CREATE TABLE IF NOT EXISTS cases (
  case_id VARCHAR(40) NOT NULL PRIMARY KEY,
  case_date DATE NOT NULL,
  emp_code VARCHAR(20) NOT NULL,
  customer VARCHAR(80) NOT NULL DEFAULT '',
  bank VARCHAR(60) NOT NULL DEFAULT '',
  product VARCHAR(40) NOT NULL DEFAULT '',
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  stage VARCHAR(20) NOT NULL,
  stage_date DATE NULL,
  updated_by VARCHAR(190) NOT NULL DEFAULT '',
  source VARCHAR(12) NOT NULL DEFAULT 'APP',
  rm VARCHAR(40) NOT NULL DEFAULT '',
  location VARCHAR(60) NOT NULL DEFAULT '',
  reason VARCHAR(200) NOT NULL DEFAULT ''
);
CREATE INDEX idx_cases_date ON cases (case_date);
CREATE INDEX idx_cases_emp_date ON cases (emp_code, case_date);

-- Why a case has not moved. Written in the app, kept for history.
CREATE TABLE IF NOT EXISTS case_notes (
  note_id INT AUTO_INCREMENT PRIMARY KEY,
  case_id VARCHAR(40) NOT NULL,
  note_at VARCHAR(20) NOT NULL,
  by_name VARCHAR(190) NOT NULL DEFAULT '',
  note VARCHAR(300) NOT NULL DEFAULT ''
);
CREATE INDEX idx_case_notes_case ON case_notes (case_id);

-- Which device and app (installed or browser tab) each team leader or admin signs in from.
CREATE TABLE IF NOT EXISTS devices (
  device_id VARCHAR(64) NOT NULL,
  email_key VARCHAR(190) NOT NULL,
  email VARCHAR(190) NOT NULL DEFAULT '',
  name VARCHAR(80) NOT NULL DEFAULT '',
  role VARCHAR(10) NOT NULL DEFAULT '',
  device VARCHAR(60) NOT NULL DEFAULT '',
  mode VARCHAR(30) NOT NULL DEFAULT '',
  platform VARCHAR(30) NOT NULL DEFAULT '',
  first_seen VARCHAR(20) NOT NULL DEFAULT '',
  last_seen VARCHAR(20) NOT NULL DEFAULT '',
  sign_ins INT NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, email_key)
);

-- Small server state, such as the result of the last backend sync.
CREATE TABLE IF NOT EXISTS app_state (
  state_key VARCHAR(60) NOT NULL PRIMARY KEY,
  state_value TEXT NOT NULL
);
