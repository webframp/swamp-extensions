## 2026.09.17.2

Add net_unit_price field to the billing/usage schema, generated as optional so
reading a resource stored under an older model version no longer throws Required
now that the live API adds this field.
