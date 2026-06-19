'use strict';

module.exports = (sequelize, DataTypes) => {
  const Subscription = sequelize.define(
    'Subscription',
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
      plan_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('pending', 'active', 'cancelled'),
        allowNull: false,
        defaultValue: 'pending',
      },
      active_until: DataTypes.DATE,
      paystack_reference: DataTypes.STRING,
      amount_ngn: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: 'subscriptions',
      underscored: true,
    }
  );

  Subscription.associate = (models) => {
    Subscription.belongsTo(models.Tenant, { foreignKey: 'tenant_id' });
    Subscription.belongsTo(models.Plan, { foreignKey: 'plan_id' });
  };

  return Subscription;
};
