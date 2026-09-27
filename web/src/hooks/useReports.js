import { useQuery } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

const MONTH_MAP = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12
}

export function useReportsData(monthLabel, selectedDept = 'all', selectedEmpId = 'all') {
  const [monthName, yearStr] = monthLabel ? monthLabel.split(' ') : ['March', '2026']
  const year = parseInt(yearStr, 10) || new Date().getFullYear()
  const month = MONTH_MAP[monthName] || (new Date().getMonth() + 1)

  const lastDay = new Date(year, month, 0).getDate()
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`
  const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`

  return useQuery({
    queryKey: ['reports_data', monthLabel, selectedDept, selectedEmpId],
    queryFn: async () => {
      const [
        { data: profiles, error: profErr },
        { data: attendance, error: attErr },
        { data: leaveRequests, error: lrErr },
        { data: leaveBalances, error: lbErr },
        { data: payslips, error: payErr },
        { data: payrollRuns, error: runErr },
        { data: salaryStructures, error: ssErr },
      ] = await Promise.all([
        supabase.from('profiles').select('*'),
        supabase.from('attendance').select('*').gte('date', startDate).lte('date', endDate),
        supabase.from('leave_requests').select('*').eq('status', 'approved').lte('from_date', endDate).gte('to_date', startDate),
        supabase.from('leave_balances').select('*').eq('year', year),
        supabase.from('payslips').select('*'),
        supabase.from('payroll_runs').select('*'),
        supabase.from('salary_structures').select('*'),
      ])

      if (profErr) throw profErr
      if (attErr) throw attErr
      if (lrErr) throw lrErr
      if (lbErr) throw lbErr
      if (payErr) throw payErr
      if (runErr) throw runErr
      if (ssErr) throw ssErr

      // Filter profiles by department and employee ID if specified
      let filteredProfiles = profiles || []
      if (selectedDept && selectedDept !== 'all') {
        filteredProfiles = filteredProfiles.filter(p => (p.department || 'General').toLowerCase() === selectedDept.toLowerCase())
      }
      if (selectedEmpId && selectedEmpId !== 'all') {
        filteredProfiles = filteredProfiles.filter(p => p.id === selectedEmpId || p.employee_id === selectedEmpId)
      }

      // Extract unique list of departments from all profiles
      const departments = Array.from(new Set((profiles || []).map(p => p.department).filter(Boolean)))

      // 1. Attendance Monthly Summary (Accurate attendance percentage, no WFH double counting)
      const attendanceSummary = filteredProfiles.map(emp => {
        const empAtt = (attendance || []).filter(a => a.employee_id === emp.id)
        const present = empAtt.filter(a => a.status === 'present').length
        const wfh = empAtt.filter(a => a.status === 'wfh').length
        const late = empAtt.filter(a => a.status === 'late').length
        const absent = empAtt.filter(a => a.status === 'absent').length
        const halfDay = empAtt.filter(a => a.status === 'half_day').length
        const total = empAtt.length
        
        const attendedDays = present + wfh + late + (halfDay * 0.5)
        const workingDays = present + wfh + late + absent + halfDay
        const pct = workingDays > 0 ? Math.round((attendedDays / workingDays) * 100) : (total > 0 ? 100 : 0)

        return {
          id: emp.employee_id || emp.id.slice(0, 8),
          rawId: emp.id,
          name: emp.full_name,
          dept: emp.department || 'General',
          present,
          absent,
          late,
          wfh,
          halfDay,
          total,
          pct
        }
      })

      // 2. Leave Summary (Approved leaves within selected date range)
      const leaveSummary = filteredProfiles.map(emp => {
        const empLeaves = (leaveRequests || []).filter(r => r.employee_id === emp.id)
        const casual = empLeaves.filter(r => r.leave_type === 'casual').reduce((sum, r) => sum + (r.days || 1), 0)
        const sick = empLeaves.filter(r => r.leave_type === 'sick').reduce((sum, r) => sum + (r.days || 1), 0)
        const earned = empLeaves.filter(r => r.leave_type === 'earned').reduce((sum, r) => sum + (r.days || 1), 0)
        const wfh = empLeaves.filter(r => r.leave_type === 'wfh').reduce((sum, r) => sum + (r.days || 1), 0)
        const comp_off = empLeaves.filter(r => r.leave_type === 'comp_off').reduce((sum, r) => sum + (r.days || 1), 0)
        const total = casual + sick + earned + wfh + comp_off

        return {
          id: emp.employee_id || emp.id.slice(0, 8),
          rawId: emp.id,
          name: emp.full_name,
          dept: emp.department || 'General',
          casual,
          sick,
          earned,
          wfh,
          comp_off,
          total
        }
      })

      // 3. Leave Balance
      const leaveBalancesReport = filteredProfiles.map(emp => {
        const bal = (leaveBalances || []).find(b => b.employee_id === emp.id) || { casual: 12, sick: 12, earned: 18, wfh: 24, comp_off: 5 }
        return {
          id: emp.employee_id || emp.id.slice(0, 8),
          rawId: emp.id,
          name: emp.full_name,
          dept: emp.department || 'General',
          casual_bal: bal.casual ?? 12,
          sick_bal: bal.sick ?? 12,
          earned_bal: bal.earned ?? 18,
          wfh_bal: bal.wfh ?? 24,
          comp_off_bal: bal.comp_off ?? 5,
        }
      })

      // 4. Payroll Monthly Summary
      const currentRun = (payrollRuns || []).find(r => r.month === month && r.year === year)
      const monthlyPayslips = currentRun 
        ? (payslips || []).filter(p => p.payroll_run_id === currentRun.id)
        : []

      const payrollSummary = filteredProfiles.map(emp => {
        const slip = monthlyPayslips.find(p => p.employee_id === emp.id) || (payslips || []).find(p => p.employee_id === emp.id)
        const struct = (salaryStructures || []).find(s => s.employee_id === emp.id)

        // Recorded figures only. This used to fall back to an estimate worked
        // out from CTC, and printed a "PF account number" made up from the PAN
        // (MH/BOM/<PAN>/001) — a statutory identifier nobody had issued. What
        // is not on record is null, and the page shows a dash.
        // These reports move to the server's payroll records on Day 19.
        const recorded = (value) => (value === null || value === undefined ? null : Number(value))

        const gross = recorded(slip?.gross ?? struct?.gross)
        const basic = recorded(slip?.basic ?? struct?.basic)
        const pf = recorded(slip?.pf ?? struct?.pf)
        const esi = recorded(slip?.esi ?? struct?.esi)
        const pt = recorded(slip?.pt ?? struct?.pt)
        const net = recorded(slip?.net ?? struct?.net_salary)
        const uan = emp.uan || null

        return {
          id: emp.employee_id || emp.id.slice(0, 8),
          rawId: emp.id,
          name: emp.full_name,
          dept: emp.department || 'General',
          gross,
          basic,
          pf,
          esi,
          pt,
          net,
          uan,
        }
      })

      // 5. Headcount by Dept
      const deptCounts = {}
      filteredProfiles.filter(p => p.status === 'active').forEach(p => {
        const d = p.department || 'General'
        deptCounts[d] = (deptCounts[d] || 0) + 1
      })
      const colors = ['#2563EB', '#16A34A', '#D97706', '#7C3AED', '#DC2626', '#0891B2', '#DB2777']
      const headcountByDept = Object.entries(deptCounts).map(([name, value], i) => ({
        name,
        value,
        color: colors[i % colors.length]
      }))

      // 6. Monthly Payroll Trend (past 6 months)
      const trendData = []
      for (let i = 5; i >= 0; i--) {
        const d = new Date(year, month - 1 - i, 1)
        const mVal = d.getMonth() + 1
        const yVal = d.getFullYear()
        const mLabel = d.toLocaleString('en-US', { month: 'short' })
        
        // A month with no payroll run has no payout — not a guess of one.
        const run = (payrollRuns || []).find(r => r.month === mVal && r.year === yVal)
        trendData.push({
          month: mLabel,
          amount: run ? Number((Number(run.total_net) / 100000).toFixed(2)) : null
        })
      }

      // 7. Joiners & Exits
      const joinersList = filteredProfiles
        .filter(p => p.date_of_joining >= startDate && p.date_of_joining <= endDate)
        .map(p => ({
          id: p.employee_id || p.id.slice(0, 8),
          rawId: p.id,
          name: p.full_name,
          dept: p.department || 'General',
          role: p.designation || 'Staff',
          date: new Date(p.date_of_joining).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
          type: 'joiner'
        }))

      const exitsList = filteredProfiles
        .filter(p => p.status === 'inactive')
        .map(p => ({
          id: p.employee_id || p.id.slice(0, 8),
          rawId: p.id,
          name: p.full_name,
          dept: p.department || 'General',
          role: p.designation || 'Staff',
          date: 'Inactive',
          type: 'exit'
        }))

      return {
        departments,
        allEmployees: (profiles || []).map(p => ({ id: p.id, employee_id: p.employee_id, name: p.full_name, dept: p.department })),
        attendanceSummary,
        leaveSummary,
        leaveBalancesReport,
        payrollSummary,
        headcountByDept,
        payrollTrend: trendData,
        joinersExits: [...joinersList, ...exitsList],
        totalEmployees: filteredProfiles.filter(p => p.status === 'active').length,
      }
    }
  })
}
