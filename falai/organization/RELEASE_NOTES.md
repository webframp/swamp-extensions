## 2026.09.17.2

Add quantity/unit fields to billing event schema; output_units/custom_units are
now documented as deprecated aliases of quantity/unit (still returned, no
removal). Also: quantity/unit and the new usage fields
(percent_discount/cost_subtotal/cost_discount/cost_total) are generated as
optional/nullable-optional so reading a resource stored under an older model
version no longer throws Required now that the live API adds these fields.
