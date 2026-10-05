/**
 * Ways through the app's own furniture that more than one suite takes — so
 * when the look changes, they change here once.
 *
 * Since the new look (Oct 2026): My Profile is a page with tabs, reached from
 * the user menu in the top bar on a computer, or the Menu drawer on a phone;
 * Sign Out sits beside it.
 */

/** Opens My Profile the way a person would, and the named tab — 'About me', 'My details', 'My employment', 'Salary account', 'Password'. */
export async function openMyProfile(page, tab = null) {
  const phoneMenu = page.getByRole('button', { name: 'Open menu' })
  if (await phoneMenu.isVisible()) {
    await phoneMenu.click()
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'My Profile' }).click()
  } else {
    await page.locator('header [aria-haspopup="menu"]').click()
    await page.getByRole('menuitem', { name: 'My Profile' }).click()
  }
  await page.waitForURL('**/profile**', { timeout: 20_000 })
  if (tab) {
    const chosen = page.getByRole('tab', { name: tab })
    await chosen.waitFor({ timeout: 20_000 })
    await chosen.click()
  }
}

/**
 * Somebody's profile, from the Employees list — a page of its own since the
 * new look (it was a drawer over the list) — on the named tab: 'About',
 * 'Employment', 'Logins' (or 'Login'), 'Documents', 'Salary', 'Statutory',
 * 'Bank account'. Returns <main>, where the profile is.
 */
export async function openEmployeeProfile(page, base, name, tab = null) {
  await page.goto(`${base}/employees`)
  const link = page.locator('main').getByRole('link', { name: new RegExp(`^${name}\\b`) }).filter({ visible: true }).first()
  await link.waitFor({ timeout: 20_000 })
  await link.click()
  await page.waitForURL(/\/employees\/[0-9a-f-]{36}/, { timeout: 20_000 })
  await page.getByRole('heading', { name, level: 1 }).waitFor({ timeout: 20_000 })
  if (tab) await page.getByRole('tab', { name: tab }).click()
  return page.locator('main')
}

/** Signs out from the user menu (computer) or the Menu drawer (phone). */
export async function signOutVia(page) {
  const phoneMenu = page.getByRole('button', { name: 'Open menu' })
  if (await phoneMenu.isVisible()) {
    await phoneMenu.click()
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('button', { name: 'Sign Out' }).click()
  } else {
    await page.locator('header [aria-haspopup="menu"]').click()
    await page.getByRole('menuitem', { name: 'Sign Out' }).click()
  }
}

/**
 * The left-hand menu's links, by name — the sidebar on a computer. "Home" and
 * "Payslips" since the new look (they were "Dashboard" and "My Payslips").
 */
export async function menuLinks(page) {
  const links = page.getByRole('navigation', { name: 'Main' }).first().getByRole('link')
  // Drawn once the session is read: wait for it, as reading text would have.
  await links.first().waitFor({ timeout: 20_000 })
  // The label only: not the "3 waiting" count beside it, nor the marker on the open one.
  return links.evaluateAll((links) => links.map((a) =>
    ([...a.querySelectorAll('span')].find((s) => !s.hasAttribute('aria-hidden') && !s.hasAttribute('aria-label'))?.textContent ?? a.textContent).trim()))
}

/**
 * The panel the bell opens, by its name — it was found by its shadow and
 * corners, which the new look changed. Its rows are the notices.
 */
export function notificationPanel(page) {
  return page.getByRole('dialog', { name: 'Notifications' })
}

/** A link in the left-hand menu, by its label — whatever count sits beside it. */
export function menuLink(page, label) {
  return page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: new RegExp(`^${label}\\b`) })
}
