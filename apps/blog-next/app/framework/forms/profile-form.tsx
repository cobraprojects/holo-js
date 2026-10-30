'use client'

import { useValidationErrors } from '@holo-js/adapter-next/client'
import { saveProfile } from './actions'

export function ProfileForm() {
  const defaultErrors = useValidationErrors()
  const profileErrors = useValidationErrors('profile')

  return (
    <form action={saveProfile}>
      <span data-default-error>{defaultErrors.first('email') ?? ''}</span>
      <span data-profile-error>{profileErrors.first('email') ?? ''}</span>
      <label>
        Profile email
        <input name="email" />
      </label>
      <label>
        Profile password
        <input name="password" type="password" />
      </label>
      <button>Save profile</button>
    </form>
  )
}
