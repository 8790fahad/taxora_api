const { XMLParser } = require('fast-xml-parser');
const config = require('../config');

// TallyPrime integration over HTTP/XML.
//
// Tally exposes an XML gateway (default port 9000) on the local machine or a
// network host. There are no credentials — access is controlled by the network
// — so a "connection" is just a reachable URL + the company to read from.
//
// All requests are XML POSTs to the gateway; responses are XML which we parse
// into JSON internally with fast-xml-parser.

const DEFAULT_TIMEOUT_MS = 20000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  trimValues: true,
});

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Tally dates are YYYYMMDD.
function toTallyDate(input) {
  const d = input ? new Date(input) : new Date();
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Build an "Export Data" envelope for a named report, optionally scoped to a
 * company and date range via static variables.
 */
function buildExportEnvelope(reportId, { company, fromDate, toDate } = {}) {
  const staticVars = [
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>',
    company ? `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>` : '',
    fromDate ? `<SVFROMDATE>${escapeXml(fromDate)}</SVFROMDATE>` : '',
    toDate ? `<SVTODATE>${escapeXml(toDate)}</SVTODATE>` : '',
  ].join('');

  return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>${escapeXml(reportId)}</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>${staticVars}</STATICVARIABLES>
    </DESC>
  </BODY>
</ENVELOPE>`;
}

/**
 * POST an XML body to the Tally gateway and return the raw XML string.
 * Throws tagged errors for unreachable host / timeout / non-XML responses.
 */
async function postXml(url, xmlBody) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(normalizeUrl(url), {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: xmlBody,
      signal: controller.signal,
    });
  } catch (e) {
    const err = new Error(
      e.name === 'AbortError'
        ? 'Tally did not respond in time (timeout).'
        : `Could not reach Tally at ${normalizeUrl(url)}. Is Tally running with the XML port open?`
    );
    err.code = e.name === 'AbortError' ? 'TALLY_TIMEOUT' : 'TALLY_UNREACHABLE';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = new Error(`Tally HTTP ${res.status}`);
    err.code = 'TALLY_HTTP_ERROR';
    throw err;
  }

  const text = await res.text();
  if (!text || !text.includes('<')) {
    const err = new Error('Tally returned an invalid (non-XML) response.');
    err.code = 'TALLY_INVALID_XML';
    throw err;
  }
  return text;
}

function parseXml(xml) {
  try {
    return parser.parse(xml);
  } catch (e) {
    const err = new Error(`Could not parse Tally XML: ${e.message}`);
    err.code = 'TALLY_INVALID_XML';
    throw err;
  }
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// --- Mock data (TALLY_MOCK=true) ---------------------------------------------

function mockCompanies() {
  return ['ABC Ltd'];
}

function mockVouchersXml() {
  const today = toTallyDate(new Date());
  return `<ENVELOPE>
  <BODY><DATA><TALLYMESSAGE>
    <VOUCHER VCHTYPE="Sales">
      <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <VOUCHERNUMBER>S-1001</VOUCHERNUMBER>
      <DATE>${today}</DATE>
      <PARTYLEDGERNAME>Tally Demo Customer Ltd</PARTYLEDGERNAME>
      <PARTYGSTIN>12345678-0001</PARTYGSTIN>
      <ALLINVENTORYENTRIES.LIST>
        <STOCKITEMNAME>Consulting Service</STOCKITEMNAME>
        <ACTUALQTY>2 Nos</ACTUALQTY>
        <RATE>10000/Nos</RATE>
        <AMOUNT>20000</AMOUNT>
      </ALLINVENTORYENTRIES.LIST>
      <LEDGERENTRIES.LIST>
        <LEDGERNAME>Output VAT 7.5%</LEDGERNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <AMOUNT>1500</AMOUNT>
      </LEDGERENTRIES.LIST>
      <AMOUNT>21500</AMOUNT>
    </VOUCHER>
  </TALLYMESSAGE></DATA></BODY>
</ENVELOPE>`;
}

// --- Public API --------------------------------------------------------------

/**
 * Test a Tally connection: send a "List of Companies" export and confirm we get
 * valid XML back. Returns { ok, companies }.
 */
async function testConnection({ url, mode } = {}) {
  if (config.tallyMock) {
    return { ok: true, companies: mockCompanies(), mock: true };
  }
  if (!url) {
    const err = new Error('Tally URL is required');
    err.code = 'TALLY_MISSING_URL';
    throw err;
  }
  const xml = buildExportEnvelope('List of Companies');
  const raw = await postXml(url, xml);
  const json = parseXml(raw);
  const companies = extractCompanies(json);
  return { ok: true, companies, mode: mode || 'local', mock: false };
}

function extractCompanies(json) {
  // Tally's List of Companies report nests company names in varying shapes
  // across versions; collect any COMPANY/NAME-like leaves defensively.
  const names = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (/company/i.test(key) || /(^|\.)name$/i.test(key)) {
        asArray(value).forEach((v) => {
          if (typeof v === 'string' && v.trim()) names.add(v.trim());
          else if (v && typeof v === 'object') walk(v);
        });
      } else if (value && typeof value === 'object') {
        walk(value);
      }
    }
  };
  walk(json);
  return [...names];
}

async function fetchCompanies(url) {
  if (config.tallyMock) return mockCompanies();
  const raw = await postXml(url, buildExportEnvelope('List of Companies'));
  return extractCompanies(parseXml(raw));
}

/**
 * Fetch vouchers from the Day Book between dates for a company. Returns the
 * normalized array of VOUCHER objects (JSON).
 */
async function fetchVouchers({ url, company, fromDate, toDate }) {
  let raw;
  if (config.tallyMock) {
    raw = mockVouchersXml();
  } else {
    const xml = buildExportEnvelope('Day Book', {
      company,
      fromDate: toTallyDate(fromDate) || undefined,
      toDate: toTallyDate(toDate) || toTallyDate(new Date()),
    });
    raw = await postXml(url, xml);
  }

  const json = parseXml(raw);
  // Vouchers live under ENVELOPE.BODY.DATA.TALLYMESSAGE[].VOUCHER
  const messages = asArray(json?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE);
  const vouchers = [];
  messages.forEach((m) => {
    asArray(m?.VOUCHER).forEach((v) => vouchers.push(v));
  });
  // Some configurations place VOUCHER directly under DATA.
  asArray(json?.ENVELOPE?.BODY?.DATA?.VOUCHER).forEach((v) => vouchers.push(v));
  return vouchers;
}

module.exports = {
  normalizeUrl,
  toTallyDate,
  buildExportEnvelope,
  postXml,
  parseXml,
  testConnection,
  fetchCompanies,
  fetchVouchers,
  asArray,
};
