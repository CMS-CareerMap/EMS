/**
 * The frame of the screens before sign-in — Sign in and Set password: the
 * logo's colours on the left (from a laptop up), the form on the right with
 * the company's logo above it.
 */
export default function AuthShell({ children }) {
  return (
    <div className="min-h-dvh flex bg-white">
      <aside className="hidden lg:flex lg:w-[52%] relative overflow-hidden bg-logo text-white p-12 flex-col justify-between">
        <span aria-hidden="true" className="absolute right-[14%] top-[10%] w-56 h-56 rounded-full bg-white/20" />
        <span aria-hidden="true" className="absolute -left-20 -bottom-24 w-80 h-80 rounded-full bg-white/15" />
        <span aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(160deg,rgba(26,16,41,0.05),rgba(26,16,41,0.35))]" />

        <div className="relative">
          <span className="inline-flex rounded-2xl bg-white px-4 py-2.5 shadow-lg">
            <img src="/logo-wide.png" alt="CareerMap Solutions" className="h-10 w-auto" />
          </span>
        </div>

        <div className="relative space-y-4 max-w-md">
          <h1 className="text-4xl font-extrabold leading-[1.15] tracking-tight">HR &amp; Payroll<br />Management System</h1>
          <p className="text-white/90 leading-relaxed">
            Attendance, leave, payroll and documents for everyone at CareerMap Solutions, in one place.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            {['Employee Management', 'Attendance', 'Leave', 'Payroll', 'Reports'].map((f) => (
              <span key={f} className="px-3 py-1 rounded-full text-xs font-semibold bg-white/20 backdrop-blur-sm">{f}</span>
            ))}
          </div>
        </div>

        <p className="relative text-xs text-white/80">© {new Date().getFullYear()} CareerMap Solutions. Internal platform.</p>
      </aside>

      <main className="flex-1 flex items-center justify-center p-6 bg-white">
        <div className="w-full max-w-sm">
          <img src="/logo-wide.png" alt="CareerMap Solutions" className="h-13 w-auto mb-7" />
          {children}
        </div>
      </main>
    </div>
  )
}
