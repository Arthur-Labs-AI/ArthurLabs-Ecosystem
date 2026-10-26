Fixture F - order checkout service.

Critical workflow: POST /checkout -> validate cart -> authorize caller ->
price with discounts -> charge -> persist order -> respond. Peripheral
scripts and generated docs are low risk and must not consume the
investigation budget.
