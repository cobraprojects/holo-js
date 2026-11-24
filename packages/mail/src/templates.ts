export { DEFAULT_MAIL_SOURCES } from './defaults'
export type { DefaultMailSources } from './defaults'
export { compileMailRegistry } from './template-compiler'
export type {
  CompiledMailComponent,
  CompiledMailRegistry,
  CompiledMailTemplate,
  MailRegistrySources,
} from './template-compiler'
export type { MailTemplateDataObjectShape, MailTemplateDataShape } from './template-data'
export { renderMailLayout, renderMailTemplate, resolveMailTheme } from './template-renderer'
export { MailTemplateSyntaxError } from './template-syntax'
export type {
  MailTemplateComponentNode,
  MailTemplateFormat,
  MailTemplateNode,
  MailTemplateValueNode,
} from './template-syntax'
