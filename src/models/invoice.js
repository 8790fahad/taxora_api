'use strict';

module.exports = (sequelize, DataTypes) => {
  const Invoice = sequelize.define(
    'Invoice',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      invoice_ref: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      erp_source: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      erp_invoice_id: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM(
          'RECEIVED',
          'VALIDATING',
          'VALIDATION_FAILED',
          'QUEUED',
          'SUBMITTED',
          'PENDING_CLEARANCE',
          'CLEARED',
          'REJECTED'
        ),
        allowNull: false,
        defaultValue: 'RECEIVED',
      },
      irn: DataTypes.STRING,
      qr_payload: DataTypes.TEXT,
      canonical_json: DataTypes.JSON,
      nrs_json: DataTypes.JSON,
      invoice_email_sent_at: DataTypes.DATE,
      error_message: DataTypes.TEXT,
    },
    {
      tableName: 'invoices',
      underscored: true,
    }
  );

  Invoice.associate = (models) => {
    Invoice.belongsTo(models.Tenant, { foreignKey: 'tenant_id' });
    Invoice.hasMany(models.InvoiceEvent, { foreignKey: 'invoice_id' });
    Invoice.hasMany(models.SubmissionAttempt, { foreignKey: 'invoice_id' });
  };

  return Invoice;
};
