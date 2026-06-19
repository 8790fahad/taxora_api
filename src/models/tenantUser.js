'use strict';

module.exports = (sequelize, DataTypes) => {
  const TenantUser = sequelize.define(
    'TenantUser',
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
      user_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      role: {
        type: DataTypes.ENUM('owner', 'admin', 'viewer'),
        allowNull: false,
        defaultValue: 'owner',
      },
    },
    {
      tableName: 'tenant_users',
      underscored: true,
    }
  );

  TenantUser.associate = (models) => {
    TenantUser.belongsTo(models.Tenant, { foreignKey: 'tenant_id' });
    TenantUser.belongsTo(models.User, { foreignKey: 'user_id' });
  };

  return TenantUser;
};
