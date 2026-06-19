const config = require('../config');

const TIN_REGEX = /^\d{8}-\d{4}$/;

function validateTin(tin) {
  if (!tin || typeof tin !== 'string') {
    return { valid: false, message: 'TIN is required' };
  }
  if (!TIN_REGEX.test(tin.trim())) {
    return { valid: false, message: 'TIN must match format XXXXXXXX-XXXX' };
  }
  return { valid: true };
}

function validateInvoice(canonical, tenant) {
  const errors = [];

  const sellerTin = canonical?.seller?.tin || tenant?.tin;
  const sellerCheck = validateTin(sellerTin);
  if (!sellerCheck.valid) {
    errors.push(`Seller TIN: ${sellerCheck.message}`);
  }

  const nrsBusinessId = tenant?.nrs_business_id || config.nrsMerchantId;
  const nrsServiceId = tenant?.nrs_service_id || config.nrsServiceId || config.nrsAggregatorId;
  if (!nrsBusinessId || !nrsServiceId) {
    errors.push('Tenant NRS Business ID and Service ID are required');
  }

  const invoiceType = canonical?.type || 'B2B';
  if (invoiceType === 'B2B' || invoiceType === 'B2G') {
    const buyerCheck = validateTin(canonical?.buyer?.tin);
    if (!buyerCheck.valid) {
      errors.push(`Buyer TIN (required for ${invoiceType}): ${buyerCheck.message}`);
    }
  }

  const lineItems = canonical?.lineItems || [];
  if (lineItems.length === 0) {
    errors.push('At least one line item is required');
  }

  let computedTax = 0;
  let computedLineTotal = 0;

  lineItems.forEach((line, idx) => {
    const qty = Number(line.quantity);
    const unitPrice = Number(line.unitPrice);
    const discountRate = Number(line.discountRate || 0);
    const feeRate = Number(line.feeRate || 0);
    const taxRate = Number(line.taxRate ?? 7.5);
    const lineNo = line.lineNo ?? idx + 1;

    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`Line ${lineNo}: quantity must be positive`);
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      errors.push(`Line ${lineNo}: unit price must be non-negative`);
    }

    const gross = qty * unitPrice;
    const discountAmount =
      line.discountAmount != null
        ? Number(line.discountAmount)
        : Math.round(gross * (discountRate / 100) * 100) / 100;
    const feeAmount =
      line.feeAmount != null ? Number(line.feeAmount) : Math.round(gross * (feeRate / 100) * 100) / 100;
    const taxable =
      line.totalAmount != null ? Number(line.totalAmount) : Math.round((gross - discountAmount + feeAmount) * 100) / 100;
    const expectedTax = Math.round(taxable * (taxRate / 100) * 100) / 100;
    computedLineTotal += taxable;
    computedTax += expectedTax;

    if (line.taxAmount !== undefined) {
      const actualTax = Number(line.taxAmount);
      if (Math.abs(actualTax - expectedTax) > 0.01) {
        errors.push(
          `Line ${lineNo}: VAT math mismatch (expected ${expectedTax}, got ${actualTax})`
        );
      }
    }

    if (!line.nrsProductCode) {
      errors.push(`Line ${lineNo}: NRS product code is required`);
    }
  });

  if (canonical?.totals) {
    const { totalLineAmount, totalTax, grandTotal } = canonical.totals;
    if (totalLineAmount !== undefined && Math.abs(Number(totalLineAmount) - computedLineTotal) > 0.01) {
      errors.push('Total line amount does not match line items');
    }
    if (totalTax !== undefined && Math.abs(Number(totalTax) - computedTax) > 0.01) {
      errors.push('Total tax does not match line items');
    }
    if (grandTotal !== undefined) {
      const expectedGrand = computedLineTotal + computedTax;
      if (Math.abs(Number(grandTotal) - expectedGrand) > 0.01) {
        errors.push('Grand total does not match line items + tax');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = { validateTin, validateInvoice, TIN_REGEX };
