---
'@holo-js/validation': patch
'@holo-js/adapter-shared': patch
---

Accept a custom wrong-type message in `field.string()`, `field.password()`, `field.number()`, `field.boolean()`, and `field.date()`, applied the same way in server validation and compiled browser schemas. Date rules on non-date fields now report their own custom message when the value cannot be read as a date.
