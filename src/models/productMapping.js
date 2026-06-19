'use strict';

module.exports = (sequelize, DataTypes) => {
  const ProductMapping = sequelize.define(
    'ProductMapping',
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
      erp_sku: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      nrs_product_code: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      description: DataTypes.STRING,
    },
    {
      tableName: 'product_mappings',
      underscored: true,
    }
  );

  ProductMapping.associate = (models) => {
    ProductMapping.belongsTo(models.Tenant, { foreignKey: 'tenant_id' });
  };

  return ProductMapping;
};
