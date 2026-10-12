import { field, schema } from '@holo-js/validation'

export const contactForm = schema({
  email: field.string().required().email('Email rejected for contact.'),
  password: field.password().optional(),
})
