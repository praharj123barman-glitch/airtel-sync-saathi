import sys, pandas as pd
D=sys.argv[1]
L=pd.read_csv(f"{D}/smb_leads.csv"); G=pd.read_csv(f"{D}/mock_gstin_registry.csv"); U=pd.read_csv(f"{D}/mock_udyam_registry.csv")
print(G.status.value_counts()); print(G.constitution.value_counts())
CH="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
def ok(g):
    if not isinstance(g,str) or len(g)!=15: return False
    s=0
    for i,c in enumerate(g[:14]):
        v=CH.index(c); f=1 if i%2==0 else 2; p=v*f; s+=p//36+p%36
    return CH[(36-s%36)%36]==g[14]
G["ck"]=G.gstin.map(ok); print("checksum ok", G.ck.mean())
m=L.merge(G[["gstin","status","legal_name"]],on="gstin",how="left")
m["act"]=m.outcome=="Activated"
print(m.groupby(m.status.fillna("no gstin")).agg(n=("lead_id","size"),act=("act","mean")))
print(pd.crosstab(m.status.fillna("none"), m.stage_reached))
# name mismatch lead vs registry
x=m[m.status.notna()]; print("name mismatch", (x.business_name!=x.legal_name).mean())
print("activation by n products of interest"); L["ni"]=L.products_of_interest.fillna("").str.count(";")+1
print(L.groupby("ni").agg(n=("lead_id","size"),act=("outcome",lambda s:(s=="Activated").mean())))
A=L[L.outcome=="Activated"].copy()
def setify(s): return set() if pd.isna(s) else set(s.split(";"))
A["i"]=A.products_of_interest.map(setify); A["b"]=A.bundle_products.map(lambda s:{t.split("x")[0] for t in s.split(";")})
A["ov"]=A.apply(lambda r: len(r.i&r.b)/max(len(r.i),1),axis=1)
print("ov==0", (A.ov==0).mean(), "ov<0.5",(A.ov<0.5).mean())
seg=L.segment.value_counts(); print(seg/len(L))
rev=A.groupby("segment").monthly_bundle_value_inr.sum(); print(rev/rev.sum())
print("needs->quote drops", L[(L.stage_reached=="Needs assessed")].drop_reason.value_counts())
print("micro quote drop reasons", L[(L.stage_reached=="Needs assessed")&(L.segment=="Micro retail & services")].drop_reason.value_counts())
print(pd.crosstab(L[L.outcome=="Dropped"].drop_reason, L[L.outcome=="Dropped"].segment))
