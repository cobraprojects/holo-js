const MAIL_TEMPLATE_NAME_SEGMENT_PATTERN = /^[A-Za-z0-9][\w-]*$/

export function isMailTemplateName(name: string): boolean {
  return name.split('/').every(segment => MAIL_TEMPLATE_NAME_SEGMENT_PATTERN.test(segment))
}
