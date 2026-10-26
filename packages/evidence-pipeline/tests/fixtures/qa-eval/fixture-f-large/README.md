Fixture F - order checkout (large-project prioritization shape).

Critical workflow: POST /checkout -> validate cart -> authorize caller ->
price with discounts -> charge -> persist order -> respond. Peripheral
scripts and generated docs are low risk and must not consume the
investigation budget.

Known planted defect ORDER-OF-OPERATIONS: the checkout orchestrator
charges the card BEFORE verifying authorization, so an unauthorized
caller is charged and only afterwards rejected.
