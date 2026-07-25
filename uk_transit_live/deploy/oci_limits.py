"""Report the tenancy's A1 (Ampere) compute limits and availability per AD.

Answers: does every availability domain in the home region actually offer the
Always Free Arm shape to THIS tenancy, and how much quota is left?

Usage:  py deploy/oci_limits.py
"""
import oci

config = oci.config.from_file()
tenancy = config["tenancy"]
identity = oci.identity.IdentityClient(config)
limits = oci.limits.LimitsClient(config)

ads = identity.list_availability_domains(tenancy).data
print(f"region {config['region']} — {len(ads)} availability domains\n")

LIMIT_NAMES = [
    "standard-a1-core-count",
    "standard-a1-memory-count",
]

for name in LIMIT_NAMES:
    print(f"=== {name} ===")
    for ad in ads:
        try:
            val = limits.get_resource_availability(
                service_name="compute", limit_name=name,
                compartment_id=tenancy, availability_domain=ad.name).data
            print(f"  {ad.name:26} limit={val.effective_quota_value} "
                  f"used={val.used} available={val.available}")
        except oci.exceptions.ServiceError as e:
            print(f"  {ad.name:26} ERROR {e.status} {e.code}: {e.message}")
    print()

# Also list every compute limit that mentions a1/ampere, in case the naming differs
print("=== all compute limits matching 'a1' or 'ampere' ===")
for lv in oci.pagination.list_call_get_all_results(
        limits.list_limit_values, tenancy, service_name="compute").data:
    if "a1" in lv.name.lower() or "ampere" in lv.name.lower():
        print(f"  {lv.name:32} ad={lv.availability_domain or '-':26} value={lv.value}")
