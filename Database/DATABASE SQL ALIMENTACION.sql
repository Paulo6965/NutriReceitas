CREATE DATABASE IF NOT EXISTS receitaAcompanha;
USE receitaAcompanha;

CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    external_id VARCHAR(191) NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) NULL UNIQUE,
    locale VARCHAR(10) DEFAULT 'pt-BR',
    timezone VARCHAR(64) DEFAULT 'America/Sao_Paulo',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_preferences (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,

    preference_key VARCHAR(100) NOT NULL,
    preference_value VARCHAR(255) NULL,
    value_json JSON NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uq_user_preference (user_id, preference_key),

    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ingredients (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    name VARCHAR(150) NOT NULL,
    normalized_name VARCHAR(150) NOT NULL,
    description TEXT NULL,

    category VARCHAR(100) NULL,

    calories_per_100g DECIMAL(10,2) NULL,
    protein_per_100g DECIMAL(10,2) NULL,
    carbs_per_100g DECIMAL(10,2) NULL,
    fat_per_100g DECIMAL(10,2) NULL,
    fiber_per_100g DECIMAL(10,2) NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE KEY uq_ingredient_name (normalized_name),
    INDEX idx_ingredient_category (category)
);

CREATE TABLE IF NOT EXISTS ingredient_aliases (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    ingredient_id BIGINT UNSIGNED NOT NULL,
    alias VARCHAR(150) NOT NULL,
    normalized_alias VARCHAR(150) NOT NULL,

    UNIQUE KEY uq_alias (normalized_alias),

    FOREIGN KEY (ingredient_id)
        REFERENCES ingredients(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_ingredients (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    user_id BIGINT UNSIGNED NOT NULL,
    ingredient_id BIGINT UNSIGNED NOT NULL,

    quantity DECIMAL(12,3) NULL,
    unit VARCHAR(30) NULL,

    expires_at DATE NULL,

    status ENUM('available', 'low', 'expired', 'consumed')
        NOT NULL DEFAULT 'available',

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_user_ingredients (user_id, status),
    INDEX idx_expiration (user_id, expires_at),

    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (ingredient_id) REFERENCES ingredients(id)
);

CREATE TABLE IF NOT EXISTS recipes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    title VARCHAR(255) NOT NULL,
    description TEXT NULL,

    cuisine VARCHAR(100) NULL,
    meal_type VARCHAR(100) NULL,

    difficulty ENUM('easy', 'medium', 'hard')
        DEFAULT 'easy',

    prep_time_minutes SMALLINT UNSIGNED NULL,
    cook_time_minutes SMALLINT UNSIGNED NULL,
    total_time_minutes SMALLINT UNSIGNED NULL,

    servings DECIMAL(5,2) NULL,

    instructions LONGTEXT NULL,

    source VARCHAR(255) NULL,
    source_url VARCHAR(500) NULL,

    status ENUM('active', 'draft', 'archived')
        DEFAULT 'active',

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    FULLTEXT KEY ft_recipe_search (title, description)
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    recipe_id BIGINT UNSIGNED NOT NULL,
    ingredient_id BIGINT UNSIGNED NOT NULL,

    quantity DECIMAL(12,3) NULL,
    unit VARCHAR(30) NULL,

    optional BOOLEAN NOT NULL DEFAULT FALSE,

    preparation VARCHAR(255) NULL,

    sort_order SMALLINT UNSIGNED DEFAULT 0,

    INDEX idx_recipe (recipe_id),
    INDEX idx_ingredient (ingredient_id),

    FOREIGN KEY (recipe_id)
        REFERENCES recipes(id)
        ON DELETE CASCADE,

    FOREIGN KEY (ingredient_id)
        REFERENCES ingredients(id)
);

CREATE TABLE IF NOT EXISTS tags (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS recipe_tags (
    recipe_id BIGINT UNSIGNED NOT NULL,
    tag_id BIGINT UNSIGNED NOT NULL,

    PRIMARY KEY (recipe_id, tag_id),

    FOREIGN KEY (recipe_id)
        REFERENCES recipes(id)
        ON DELETE CASCADE,

    FOREIGN KEY (tag_id)
        REFERENCES tags(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS dietary_restrictions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    name VARCHAR(100) NOT NULL UNIQUE,
    type VARCHAR(50) NULL
);

CREATE TABLE IF NOT EXISTS user_dietary_restrictions (
    user_id BIGINT UNSIGNED NOT NULL,
    restriction_id BIGINT UNSIGNED NOT NULL,

    severity ENUM('preference', 'avoid', 'strict')
        DEFAULT 'avoid',

    PRIMARY KEY (user_id, restriction_id),

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    FOREIGN KEY (restriction_id)
        REFERENCES dietary_restrictions(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_ingredient_preferences (
    user_id BIGINT UNSIGNED NOT NULL,
    ingredient_id BIGINT UNSIGNED NOT NULL,

    preference ENUM(
        'favorite',
        'liked',
        'neutral',
        'disliked',
        'avoid'
    ) NOT NULL DEFAULT 'neutral',

    score DECIMAL(5,2) NULL,

    PRIMARY KEY (user_id, ingredient_id),

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    FOREIGN KEY (ingredient_id)
        REFERENCES ingredients(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_recipe_history (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    user_id BIGINT UNSIGNED NOT NULL,
    recipe_id BIGINT UNSIGNED NOT NULL,

    event_type ENUM(
        'viewed',
        'recommended',
        'saved',
        'cooked',
        'skipped'
    ) NOT NULL,

    rating TINYINT UNSIGNED NULL,

    notes TEXT NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_user_history (user_id, created_at),
    INDEX idx_recipe_history (recipe_id),

    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (recipe_id) REFERENCES recipes(id)
);

CREATE TABLE IF NOT EXISTS user_favorite_recipes (
    user_id BIGINT UNSIGNED NOT NULL,
    recipe_id BIGINT UNSIGNED NOT NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (user_id, recipe_id),

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE,

    FOREIGN KEY (recipe_id)
        REFERENCES recipes(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recipe_nutrition (
    recipe_id BIGINT UNSIGNED PRIMARY KEY,

    calories DECIMAL(10,2) NULL,
    protein_g DECIMAL(10,2) NULL,
    carbohydrates_g DECIMAL(10,2) NULL,
    fat_g DECIMAL(10,2) NULL,
    fiber_g DECIMAL(10,2) NULL,

    sodium_mg DECIMAL(10,2) NULL,
    sugar_g DECIMAL(10,2) NULL,

    FOREIGN KEY (recipe_id)
        REFERENCES recipes(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meal_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    user_id BIGINT UNSIGNED NOT NULL,
    recipe_id BIGINT UNSIGNED NULL,

    meal_type ENUM(
        'breakfast',
        'lunch',
        'dinner',
        'snack',
        'other'
    ) NOT NULL,

    consumed_at DATETIME NOT NULL,

    servings DECIMAL(6,2) DEFAULT 1,

    notes TEXT NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_user_meals (user_id, consumed_at),

    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (recipe_id) REFERENCES recipes(id)
);

CREATE TABLE IF NOT EXISTS user_nutrition_goals (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    user_id BIGINT UNSIGNED NOT NULL,

    calories_target DECIMAL(10,2) NULL,
    protein_target_g DECIMAL(10,2) NULL,
    carbs_target_g DECIMAL(10,2) NULL,
    fat_target_g DECIMAL(10,2) NULL,
    fiber_target_g DECIMAL(10,2) NULL,

    start_date DATE NULL,
    end_date DATE NULL,

    active BOOLEAN DEFAULT TRUE,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_active_goal (user_id, active),

    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS conversations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    user_id BIGINT UNSIGNED NOT NULL,

    channel ENUM(
        'chat',
        'voice',
        'api'
    ) DEFAULT 'chat',

    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_message_at DATETIME NULL,

    FOREIGN KEY (user_id) REFERENCES users(id),

    INDEX idx_user_conversations (user_id, last_message_at)
);

CREATE TABLE IF NOT EXISTS conversation_messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    conversation_id BIGINT UNSIGNED NOT NULL,

    role ENUM(
        'user',
        'assistant',
        'system',
        'tool'
    ) NOT NULL,

    content LONGTEXT NOT NULL,

    tool_name VARCHAR(100) NULL,

    metadata JSON NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_conversation_messages (
        conversation_id,
        created_at
    ),

    FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_memories (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    user_id BIGINT UNSIGNED NOT NULL,

    memory_type VARCHAR(50) NOT NULL,
    memory_key VARCHAR(150) NOT NULL,

    value_text TEXT NULL,
    value_json JSON NULL,

    confidence DECIMAL(5,4) NULL,

    source_conversation_id BIGINT UNSIGNED NULL,

    expires_at DATETIME NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_user_memory (
        user_id,
        memory_type,
        memory_key
    ),

    FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
);
