'use strict';

module.exports = (sequelize, DataTypes) => {
  const ErpConnection = sequelize.define(
    'ErpConnection',
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
      connector_type: {
        type: DataTypes.ENUM('quickbooks', 'sage', 'zoho', 'odoo', 'tally', 'flowbooks', 'manual'),
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('pending', 'connected', 'error'),
        allowNull: false,
        defaultValue: 'pending',
      },
      config: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: {},
      },
      health_status: DataTypes.STRING,
      last_sync_at: DataTypes.DATE,
    },
    {
      tableName: 'erp_connections',
      underscored: true,
    }
  );

  ErpConnection.associate = (models) => {
    ErpConnection.belongsTo(models.Tenant, { foreignKey: 'tenant_id' });
  };

  return ErpConnection;
};
