/**
 * The single source of truth for which models belong to a company.
 *
 * `scoped.ts` uses this to decide what to filter, and `tenant.test.ts` uses the
 * same list to assert the schema agrees. One list, two consumers — so a model
 * cannot be scoped by one and forgotten by the other.
 *
 * ADD EVERY NEW MODEL to one of these. The conformance test fails otherwise.
 */

/** Not owned by any company — identity, and the company record itself. */
export const GLOBAL_MODELS = ['User', 'Organization', 'RefreshToken', 'PasswordResetToken'] as const

/** Owned by exactly one company. Every row carries organizationId. */
export const TENANT_MODELS = [
  'Membership',
  'Role',
  'Employee',
  'Department',
  'Designation',
  'Shift',
  'EmployeeFinancial',
  'EmployeeBankAccount',
  'EmployeeStatutoryIdentity',
  'LeaveType',
  'LeaveLedgerEntry',
  'OrganizationPolicy',
  'PtSlab',
  'Holiday',
  'GeofenceLocation',
  'Attendance',
  'LeaveRequest',
  'SalaryComponent',
  'EsiCoverage',
  'EmployeeSalaryComponent',
  'AuditLog',
  'PayrollRun',
  'Payslip',
  'PayslipLine',
  'EmployeeTdsDirective',
  'EmployeeMonthlyEntry',
  'BankFileTemplate',
  'DocumentType',
  'EmployeeDocument',
  'CompanyDocument',
  'Notification',
  'NotificationSetting',
  'EmploymentEvent',
  'Resignation',
] as const

export const TENANT_MODEL_SET: ReadonlySet<string> = new Set(TENANT_MODELS)

export const isTenantModel = (model: string | undefined): boolean =>
  model !== undefined && TENANT_MODEL_SET.has(model)
