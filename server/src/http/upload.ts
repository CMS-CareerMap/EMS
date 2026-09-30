import multer from 'multer'
import type { RequestHandler } from 'express'
import { MAX_UPLOAD_MB_CEILING } from '../domain/files/fileRules'
import { BadRequest, PayloadTooLarge } from '../platform/errors/AppError'

/**
 * Reads ONE uploaded file from a multipart form, into memory.
 *
 * Memory rather than a temporary file, because the ceiling is 10 MB and the
 * next thing that happens is a hash and a write to storage — a temp file would
 * only be a second copy of an Aadhaar scan sitting on the server's disk.
 *
 * The ceiling here is the server's absolute one. The company's own cap (2 MB by
 * default) is checked by the service, where the message can say what the
 * company's limit actually is.
 */
const reader = multer({
  storage: multer.memoryStorage(),
  // Browsers send a file's name as UTF-8 without saying so; read as Latin-1 (the
  // default), "Résumé.pdf" or a name in Devanagari came out as "RÃ©sumÃ©.pdf".
  defParamCharset: 'utf8',
  limits: {
    fileSize: MAX_UPLOAD_MB_CEILING * 1024 * 1024,
    files: 1,
    fields: 30,
    fieldSize: 10_000,
  },
})

export function singleFile(field: string): RequestHandler {
  const handle = reader.single(field)
  return (req, res, next) => {
    handle(req, res, (err: unknown) => {
      if (!err) return next()
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(PayloadTooLarge(`That file is larger than ${MAX_UPLOAD_MB_CEILING} MB, the most the system accepts.`))
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
          return next(BadRequest(`Send one file, in the "${field}" field.`))
        }
        return next(BadRequest('That upload could not be read.'))
      }
      // Anything else here is the form itself being broken — cut short on a
      // phone's connection, or not multipart at all. That is the sender's to
      // retry, not a fault of the server.
      return next(BadRequest('That upload arrived incomplete or could not be read. Send the file again.'))
    })
  }
}

/** The file multer read, as the plain values a service takes. */
export interface UploadedFile {
  fileName: string
  declaredType: string
  bytes: Buffer
  size: number
}

export function uploadedFile(file: Express.Multer.File | undefined): UploadedFile | null {
  if (!file) return null
  return { fileName: file.originalname, declaredType: file.mimetype, bytes: file.buffer, size: file.size }
}
