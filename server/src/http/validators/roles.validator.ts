import { z } from 'zod'
import { roleKey } from './user.validator'

/**
 * Settings → Roles & Permissions.
 *
 * Shapes only. Whether a permission is a real one, may be given, and comes
 * with what it needs is roles.policy's question, answered in words the screen
 * can show as they are.
 */

export const roleKeyParamSchema = z.object({ key: roleKey })

const roleBody = {
  name: z.string('Give the role a name').max(80),
  description: z.string().max(400).default(''),
  parentKey: roleKey,
  permissions: z.array(z.string().max(60)).max(100),
  scopes: z.record(z.string().max(30), z.string().max(30)),
}

export const createRoleSchema = z.object(roleBody).strict()

export const updateRoleSchema = z
  .object({
    ...roleBody,
    /** The version the editor was opened at; a newer one means somebody else saved in between. */
    version: z.string().regex(/^\d+$/, 'Reload the role and try again'),
  })
  .strict()

export const resetRoleSchema = z.object({ version: z.string().regex(/^\d+$/, 'Reload the role and try again') }).strict()
