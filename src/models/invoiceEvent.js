'use strict';

module.exports = (sequelize, DataTypes) => {
  const InvoiceEvent = sequelize.define(
    'InvoiceEvent',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      invoice_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      event_type: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      payload: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: {},
      },
    },
    {
      tableName: 'invoice_events',
      underscored: true,
      updatedAt: false,
    }
  );

  InvoiceEvent.associate = (models) => {
    InvoiceEvent.belongsTo(models.Invoice, { foreignKey: 'invoice_id' });
  };

  return InvoiceEvent;
};
