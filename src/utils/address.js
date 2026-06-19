// Canonical address shape used for NRS e-invoicing:
//   line       - street address           (required if address sent)
//   city       - city                      (required if address sent)
//   country    - ISO 3166-1 alpha-2 (NG)   (required if address sent)
//   postalZone - postal code               (optional)
function formatTenantAddress(tenant) {
  return {
    line: tenant.address_line || null,
    city: tenant.address_city || null,
    country: tenant.address_country || 'NG',
    postalZone: tenant.address_postal_zone || null,
  };
}

module.exports = { formatTenantAddress };
