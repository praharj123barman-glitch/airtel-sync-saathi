import sys
import pandas as pd
import numpy as np

D = sys.argv[1]
pd.set_option("display.width", 250)
pd.set_option("display.max_columns", 40)
pd.set_option("display.max_rows", 200)

L = pd.read_csv(f"{D}/smb_leads.csv", parse_dates=[
    "created_date", "contacted_date", "needs_assessed_date", "quote_accepted_date",
    "kyc_complete_date", "activated_date"])
L["act"] = (L.outcome == "Activated").astype(int)
L["churn"] = (L.churned_within_6_months == "Y").astype(float).where(L.act == 1)

print("rows", len(L), "activated", L.act.sum(), f"{L.act.mean():.2%}")
print("\n== stage_reached counts")
print(L.stage_reached.value_counts())

order = ["Lead", "Contacted", "Needs assessed", "Quote accepted", "KYC complete", "Activated"]

def funnel(df):
    idx = {s: i for i, s in enumerate(order)}
    r = df.stage_reached.map(idx)
    return [int((r >= i).sum()) for i in range(len(order))]

print("\n== drop reasons by stage_reached")
dr = L[L.outcome == "Dropped"].groupby(["stage_reached", "drop_reason"]).size()
print(dr.sort_values(ascending=False).to_string())

def grp(col):
    g = L.groupby(col).agg(
        leads=("lead_id", "size"),
        act_rate=("act", "mean"),
        cac_per_lead=("acquisition_cost_inr", "mean"),
        cac_total=("acquisition_cost_inr", "sum"),
        acts=("act", "sum"),
    )
    g["cost_per_activation"] = g.cac_total / g.acts.replace(0, np.nan)
    a = L[L.act == 1].groupby(col).agg(
        mrr=("monthly_bundle_value_inr", "median"),
        mrr_mean=("monthly_bundle_value_inr", "mean"),
        days=("days_lead_to_activation", "mean"),
        calls=("customer_follow_up_calls", "mean"),
        churn=("churn", "mean"),
        nps=("nps_score", "mean"),
        contract=("contract_months", "mean"),
    )
    out = g.join(a)
    print(f"\n== by {col}")
    print(out.round(3).to_string())

for c in ["segment", "lead_source", "city_tier", "has_gstin", "has_udyam", "preferred_language",
          "current_internet", "current_provider", "annual_turnover_band", "contact_role"]:
    grp(c)

print("\n== funnel by segment")
for s, df in L.groupby("segment"):
    f = funnel(df)
    print(s, f, [f"{f[i]/f[i-1]:.0%}" for i in range(1, len(f))])
print("\n== funnel by source")
for s, df in L.groupby("lead_source"):
    f = funnel(df)
    print(s, f, [f"{f[i]/f[i-1]:.0%}" for i in range(1, len(f))])

A = L[L.act == 1].copy()
print("\n== activated summary")
print(A[["days_lead_to_activation", "customer_follow_up_calls", "monthly_bundle_value_inr",
         "one_time_setup_inr", "contract_months", "nps_score", "acquisition_cost_inr"]].describe().round(1).to_string())
print("churn rate", A.churn.mean())
print("overall CAC per activation", L.acquisition_cost_inr.sum() / A.shape[0])

print("\n== churn / nps by follow-up calls")
print(A.groupby("customer_follow_up_calls").agg(n=("lead_id", "size"), churn=("churn", "mean"), nps=("nps_score", "mean"), days=("days_lead_to_activation", "mean")).round(3).to_string())
A["days_band"] = pd.cut(A.days_lead_to_activation, [0, 10, 14, 18, 22, 30, 100])
print(A.groupby("days_band", observed=True).agg(n=("lead_id", "size"), churn=("churn", "mean"), nps=("nps_score", "mean")).round(3).to_string())
print("\n== churn by contract months")
print(A.groupby("contract_months").agg(n=("lead_id", "size"), churn=("churn", "mean"), nps=("nps_score", "mean"), mrr=("monthly_bundle_value_inr", "median")).round(3).to_string())

# bundle size
A["n_products"] = A.bundle_products.str.count(";") + 1
print("\n== churn by number of products in bundle")
print(A.groupby("n_products").agg(n=("lead_id", "size"), churn=("churn", "mean"), nps=("nps_score", "mean"), mrr=("monthly_bundle_value_inr", "median")).round(3).to_string())

# product frequency by segment
rows = []
for _, r in A.iterrows():
    for item in r.bundle_products.split(";"):
        pid, q = item.split("x")
        rows.append((r.segment, pid, int(q), r.lead_id))
B = pd.DataFrame(rows, columns=["segment", "pid", "qty", "lead_id"])
print("\n== product attach rate in activated bundles by segment")
seg_n = A.groupby("segment").size()
att = B.groupby(["segment", "pid"]).lead_id.nunique().unstack(0).fillna(0)
print((att / seg_n).round(2).to_string())
print("\n== median qty by segment/product")
print(B.groupby(["segment", "pid"]).qty.median().unstack(0).to_string())

# interest vs bought
def setify(s):
    return set() if pd.isna(s) else set(s.split(";"))
A["interest"] = A.products_of_interest.map(setify)
A["bought"] = A.bundle_products.map(lambda s: {x.split("x")[0] for x in s.split(";")})
A["overlap"] = A.apply(lambda r: len(r.interest & r.bought) / max(len(r.interest), 1), axis=1)
print("\n== interest coverage of bought bundle (activated)")
print(A.overlap.describe().round(2))
A["ov_band"] = pd.cut(A.overlap, [-0.01, 0.34, 0.67, 1.0])
print(A.groupby("ov_band", observed=True).agg(n=("lead_id", "size"), churn=("churn", "mean"), nps=("nps_score", "mean")).round(3).to_string())

# stage durations
for a, b in [("created_date", "contacted_date"), ("contacted_date", "needs_assessed_date"),
             ("needs_assessed_date", "quote_accepted_date"), ("quote_accepted_date", "kyc_complete_date"),
             ("kyc_complete_date", "activated_date")]:
    d = (L[b] - L[a]).dt.days
    print(f"{a} -> {b}: mean {d.mean():.1f}  median {d.median():.1f}  n {d.notna().sum()}")

print("\n== spend vs bundle (activated)")
print((A.monthly_bundle_value_inr / A.monthly_telecom_spend_inr).describe().round(2))
print("\n== monthly_telecom_spend by segment (all leads)")
print(L.groupby("segment").monthly_telecom_spend_inr.describe().round(0).to_string())
print("\n== employees / sites by segment")
print(L.groupby("segment")[["employee_count", "num_sites"]].median().to_string())
print("\n== language x tier")
print(pd.crosstab(L.preferred_language, L.city_tier))
