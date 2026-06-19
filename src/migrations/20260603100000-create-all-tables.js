'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('users', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      email: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      password_hash: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      full_name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.createTable('tenants', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      legal_name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      tin: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      rc_number: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      address: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      nrs_business_id: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      nrs_service_id: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM(
          'DRAFT',
          'REGISTERED',
          'ERP_CONNECTED',
          'SUBSCRIBED',
          'ACTIVE',
          'SUSPENDED',
          'CANCELLED'
        ),
        allowNull: false,
        defaultValue: 'DRAFT',
      },
      onboarding: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: Sequelize.literal(
          '\'{"register":false,"erp":false,"subscribe":false}\''
        ),
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.createTable('tenant_users', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      role: {
        type: Sequelize.ENUM('owner', 'admin', 'viewer'),
        allowNull: false,
        defaultValue: 'owner',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('tenant_users', ['tenant_id', 'user_id'], {
      unique: true,
      name: 'tenant_users_tenant_user_unique',
    });

    await queryInterface.createTable('plans', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      code: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      price_ngn: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      invoice_quota_monthly: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 100,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.createTable('subscriptions', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      plan_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      status: {
        type: Sequelize.ENUM('pending', 'active', 'cancelled'),
        allowNull: false,
        defaultValue: 'pending',
      },
      active_until: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      paystack_reference: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.createTable('erp_connections', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      connector_type: {
        type: Sequelize.ENUM('quickbooks', 'sage', 'manual'),
        allowNull: false,
      },
      status: {
        type: Sequelize.ENUM('pending', 'connected', 'error'),
        allowNull: false,
        defaultValue: 'pending',
      },
      config: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: Sequelize.literal("'{}'"),
        comment: 'Production: encrypt OAuth tokens at rest',
      },
      health_status: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      last_sync_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.createTable('invoices', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      invoice_ref: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      erp_source: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      erp_invoice_id: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      status: {
        type: Sequelize.ENUM(
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
      irn: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      qr_payload: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      canonical_json: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('invoices', ['tenant_id', 'status'], {
      name: 'invoices_tenant_status_idx',
    });

    await queryInterface.createTable('invoice_events', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      invoice_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'invoices', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      event_type: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      payload: {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: Sequelize.literal("'{}'"),
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.createTable('product_mappings', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      tenant_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      erp_sku: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      nrs_product_code: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      description: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('product_mappings', ['tenant_id', 'erp_sku'], {
      unique: true,
      name: 'product_mappings_tenant_sku_unique',
    });

    await queryInterface.createTable('submission_attempts', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      invoice_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'invoices', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      attempt_no: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      request_json: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      response_json: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      http_status: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('submission_attempts');
    await queryInterface.dropTable('product_mappings');
    await queryInterface.dropTable('invoice_events');
    await queryInterface.dropTable('invoices');
    await queryInterface.dropTable('erp_connections');
    await queryInterface.dropTable('subscriptions');
    await queryInterface.dropTable('plans');
    await queryInterface.dropTable('tenant_users');
    await queryInterface.dropTable('tenants');
    await queryInterface.dropTable('users');
  },
};
