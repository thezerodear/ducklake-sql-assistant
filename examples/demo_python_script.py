import duckdb

# Connect to DuckDB
con = duckdb.connect()

# 1. Autocomplete & Highlighting in con.sql("""...""")
# Type 'u.' to autosuggest columns from lake_users!
# Type 'FROM ' to autosuggest DuckLake tables!
df = con.sql("""
    SELECT 
        u.user_id,
        u.username,
        u.email,
        e.event_type,
        e.created_at
    FROM lake_users u
    JOIN lake_events e ON u.user_id = e.tenant_id
    WHERE u.status = 'ACTIVE'
    ORDER BY e.created_at DESC
    LIMIT 50;
""").df()

# 2. Autocomplete & Highlighting with magic comment --sql
report_query = """--sql
    SELECT 
        metric_date,
        total_events,
        active_users,
        avg_latency_ms
    FROM lake_metrics_daily
    WHERE avg_latency_ms > 120.0
"""

# 3. DuckDB Lakehouse analytics functions
parquet_query = """
    SELECT 
        event_id,
        date_trunc('day', created_at) as event_date,
        count(*) as total
    FROM read_parquet('s3://my-ducklake/data/*.parquet')
    GROUP BY 1, 2
"""
