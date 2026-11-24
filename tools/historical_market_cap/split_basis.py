"""Resolve split bases and correct daily market cap estimates."""

from __future__ import annotations
from pathlib import Path
import numpy as np
import pandas as pd

ROOT=Path('C:/Stocks')

FINAL=ROOT/'data/research/market_cap_daily_estimate_scale_11958/final'

DAILY_SRC=(ROOT/'data/daily/year=*/month=*.parquet').as_posix()

SNAPSHOTS=(FINAL/'ticker_overview_monthly_snapshots'/'part-*.parquet').as_posix()

SEC_PIT=ROOT/'data/research/market_cap_pit_sec_100_identity_audit/rerun/daily_market_cap_sec_pit_100.parquet'

SPLITS=ROOT/'data/metadata/splits.parquet'

CORRECTABLE='confirmed_reexpressed_post_basis'

UNKNOWN_PREFIX='unknown_'

def nonempty(x):
    return None if pd.isna(x) or str(x).strip()=='' else str(x).strip()

def close_to_factor(actual,expected,tol):
    if actual is None or expected is None or not np.isfinite(actual) or not np.isfinite(expected) or expected<=0:
        return False
    return abs(actual/expected-1)<=tol

def shares_positive(row):
    v=row.get('weighted_shares_outstanding')
    return pd.notna(v) and np.isfinite(float(v)) and float(v)>0

def same_snapshot_identity(pre,post):
    if pre is None or post is None:
        return False,'missing_snapshot'
    p_cik=nonempty(pre.get('cik')); q_cik=nonempty(post.get('cik'))
    p_figi=nonempty(pre.get('share_class_figi')); q_figi=nonempty(post.get('share_class_figi'))
    if p_cik and q_cik and p_cik!=q_cik:
        return False,'cik_changed'
    if p_figi and q_figi and p_figi!=q_figi:
        return False,'share_class_figi_changed'
    if (p_cik and q_cik and p_cik==q_cik) or (p_figi and q_figi and p_figi==q_figi):
        return True,'cik_or_share_class_stable'
    return False,'no_shared_stable_identifier'

def load_event_evidence(con, *, splits=None, snapshots=None, sec=None, daily_src=None):
    events = pd.read_parquet(SPLITS) if splits is None else splits
    if events.empty:
        return pd.DataFrame(columns=["ticker", "basis_status"])
    daily_src = daily_src or DAILY_SRC
    events=events.copy()
    events['ticker']=events.ticker.astype(str)
    events['execution_date']=pd.to_datetime(events.execution_date,errors='coerce').dt.date
    events=events.dropna(subset=['ticker','execution_date']).reset_index(drop=True)
    events['event_id']=events.id.astype(str)
    events['share_multiplier']=pd.to_numeric(events.split_to,errors='coerce')/pd.to_numeric(events.split_from,errors='coerce')
    events=events[np.isfinite(events.share_multiplier) & events.share_multiplier.gt(0)].reset_index(drop=True)

    con.register('basis_events',events[['event_id','ticker','execution_date']])
    prices=con.execute(f"""
      SELECT e.event_id,
        MAX(CAST(d.date AS DATE)) FILTER (WHERE CAST(d.date AS DATE)<e.execution_date) AS pre_date,
        ARG_MAX(d.close,CAST(d.date AS DATE)) FILTER (WHERE CAST(d.date AS DATE)<e.execution_date) AS pre_close,
        MIN(CAST(d.date AS DATE)) FILTER (WHERE CAST(d.date AS DATE)>=e.execution_date) AS post_date,
        MIN_BY(d.close,CAST(d.date AS DATE)) FILTER (WHERE CAST(d.date AS DATE)>=e.execution_date) AS post_close
      FROM basis_events e
      LEFT JOIN read_parquet('{daily_src}') d
        ON d.ticker=e.ticker
       AND CAST(d.date AS DATE) BETWEEN e.execution_date-INTERVAL '10 days' AND e.execution_date+INTERVAL '10 days'
      GROUP BY e.event_id
    """).fetchdf()
    con.unregister('basis_events')
    events=events.merge(prices,on='event_id',how='left',validate='one_to_one')

    if snapshots is None:
        snapshots = con.execute(f"SELECT * FROM read_parquet('{SNAPSHOTS}')").df()
    snap = snapshots.sort_values(['ticker', 'snapshot_date'])
    snap_by = {t: g.reset_index(drop=True) for t, g in snap.groupby('ticker', sort=False)}
    if sec is None and SEC_PIT.exists():
        sec = pd.read_parquet(SEC_PIT)
    sec_by = {}
    if sec is not None and not sec.empty:
        valid = sec[sec.pit_status.eq('ok') & sec.shares_pit_sec.gt(0)]
        sec_by = {t: g.sort_values('session_date').reset_index(drop=True)
                  for t, g in valid.groupby('ticker', sort=False)}

    records=[]
    for ev in events.itertuples(index=False):
        m=float(ev.share_multiplier)
        event_date=pd.Timestamp(ev.execution_date)
        sg=snap_by.get(ev.ticker)
        pre=post=None
        if sg is not None:
            dates=pd.to_datetime(sg.snapshot_date).values.astype('datetime64[D]')
            i=int(np.searchsorted(dates,np.datetime64(event_date.date()),side='left'))
            # Split-day snapshots are deliberately excluded; snapshots are monthly and have no intraday basis.
            j=int(np.searchsorted(dates,np.datetime64(event_date.date()),side='right'))
            if i>0: pre=sg.iloc[i-1]
            if j<len(sg): post=sg.iloc[j]

        identity_ok,identity_note=same_snapshot_identity(pre,post)
        pre_sh=float(pre.weighted_shares_outstanding) if pre is not None and shares_positive(pre) else np.nan
        post_sh=float(post.weighted_shares_outstanding) if post is not None and shares_positive(post) else np.nan
        massive_share_ratio=post_sh/pre_sh if np.isfinite(pre_sh) and np.isfinite(post_sh) and pre_sh>0 else np.nan
        close_ratio=float(ev.post_close/ev.pre_close) if pd.notna(ev.pre_close) and pd.notna(ev.post_close) and ev.pre_close>0 else np.nan
        price_fit=close_to_factor(close_ratio,1/m,.15)

        sec_pre=sec_post=None
        sec_ratio=np.nan
        sec_pre_age=sec_post_age=None
        if ev.ticker in sec_by:
            sgsec=sec_by[ev.ticker]
            sd=pd.to_datetime(sgsec.session_date).values.astype('datetime64[D]')
            si=int(np.searchsorted(sd,np.datetime64(event_date.date()),side='left'))
            pre_i=si-1
            post_i=si
            if pre_i>=0:
                candidate=sgsec.iloc[pre_i]
                if (event_date-pd.Timestamp(candidate.session_date)).days<=120: sec_pre=candidate
            if post_i<len(sgsec):
                candidate=sgsec.iloc[post_i]
                if (pd.Timestamp(candidate.session_date)-event_date).days<=120: sec_post=candidate
        if sec_pre is not None and sec_post is not None:
            sec_pre_sh=float(sec_pre.shares_pit_sec); sec_post_sh=float(sec_post.shares_pit_sec)
            sec_ratio=sec_post_sh/sec_pre_sh if sec_pre_sh>0 else np.nan
            sec_pre_age=(event_date-pd.Timestamp(sec_pre.session_date)).days
            sec_post_age=(pd.Timestamp(sec_post.session_date)-event_date).days
        else:
            sec_pre_sh=sec_post_sh=np.nan

        massive_post_to_sec_post=post_sh/sec_post_sh if np.isfinite(post_sh) and np.isfinite(sec_post_sh) and sec_post_sh>0 else np.nan
        massive_pre_to_sec_post=pre_sh/sec_post_sh if np.isfinite(pre_sh) and np.isfinite(sec_post_sh) and sec_post_sh>0 else np.nan
        massive_pre_to_sec_pre=pre_sh/sec_pre_sh if np.isfinite(pre_sh) and np.isfinite(sec_pre_sh) and sec_pre_sh>0 else np.nan

        sec_factor_ok=close_to_factor(sec_ratio,m,.15)
        sec_no_share_factor=close_to_factor(sec_ratio,1.0,.10)
        post_match=close_to_factor(massive_post_to_sec_post,1.0,.15)
        pre_matches_post_basis=close_to_factor(massive_pre_to_sec_post,1.0,.15)
        pre_matches_sec_pre_after_factor=close_to_factor(massive_pre_to_sec_pre,m,.15)
        pre_matches_old=close_to_factor(massive_pre_to_sec_pre,1.0,.15)
        post_matches_secpost=post_match

        if not np.isfinite(m) or m<=0 or abs(m-1)<1e-8:
            status='not_actionable_factor'
        elif not price_fit:
            status='price_factor_not_confirmed'
        elif not identity_ok:
            status='unknown_identity_or_snapshot'
        elif not np.isfinite(massive_share_ratio):
            status='unknown_missing_share_pair'
        elif close_to_factor(massive_share_ratio,m,.10):
            status='shares_follow_split_factor'
        elif close_to_factor(massive_share_ratio,1.0,.05):
            if (sec_factor_ok and post_match and pre_matches_post_basis and pre_matches_sec_pre_after_factor):
                status='confirmed_reexpressed_post_basis'
            elif (sec_no_share_factor and pre_matches_old and post_matches_secpost):
                status='confirmed_no_share_multiplier'
            else:
                status='unknown_reexpressed_or_stale'
        else:
            if sec_factor_ok and post_match and pre_matches_sec_pre_after_factor:
                # SEC proves the event factor, but Massive has an independent share-count movement;
                # do not infer a whole-period scale change from a noisy observed ratio.
                status='unknown_non_split_share_change'
            elif sec_no_share_factor and pre_matches_old and post_matches_secpost:
                status='confirmed_no_share_multiplier'
            else:
                status='unknown_share_ratio'

        sec_identity=nonempty(sec_post.canonical_cik) if sec_post is not None else None
        post_cik=nonempty(post.get('cik')) if post is not None else None
        pre_cik=nonempty(pre.get('cik')) if pre is not None else None
        event_cik=post_cik or pre_cik or sec_identity
        post_figi=nonempty(post.get('share_class_figi')) if post is not None else None
        pre_figi=nonempty(pre.get('share_class_figi')) if pre is not None else None
        event_figi=post_figi or pre_figi

        records.append({
            'event_id':ev.event_id,'ticker':ev.ticker,'execution_date':event_date.date().isoformat(),
            'split_from':float(ev.split_from) if pd.notna(ev.split_from) else None,
            'split_to':float(ev.split_to) if pd.notna(ev.split_to) else None,
            'adjustment_type':ev.adjustment_type,'share_multiplier':m,
            'historical_adjustment_factor':float(ev.historical_adjustment_factor) if pd.notna(ev.historical_adjustment_factor) else None,
            'pre_close_date':str(ev.pre_date) if pd.notna(ev.pre_date) else None,
            'pre_close':float(ev.pre_close) if pd.notna(ev.pre_close) else None,
            'post_close_date':str(ev.post_date) if pd.notna(ev.post_date) else None,
            'post_close':float(ev.post_close) if pd.notna(ev.post_close) else None,
            'observed_close_ratio':close_ratio,'expected_close_ratio':1/m if m else None,
            'price_factor_relative_error':abs(close_ratio/(1/m)-1) if np.isfinite(close_ratio) else None,
            'pre_snapshot_date':str(pre.snapshot_date) if pre is not None else None,
            'post_snapshot_date':str(post.snapshot_date) if post is not None else None,
            'massive_shares_pre':pre_sh if np.isfinite(pre_sh) else None,
            'massive_shares_post':post_sh if np.isfinite(post_sh) else None,
            'massive_share_ratio_post_pre':massive_share_ratio if np.isfinite(massive_share_ratio) else None,
            'snapshot_identity_stable':identity_ok,'snapshot_identity_note':identity_note,
            'event_cik':event_cik,'event_share_class_figi':event_figi,
            'sec_pre_date':str(sec_pre.session_date) if sec_pre is not None else None,
            'sec_post_date':str(sec_post.session_date) if sec_post is not None else None,
            'sec_shares_pre':sec_pre_sh if np.isfinite(sec_pre_sh) else None,
            'sec_shares_post':sec_post_sh if np.isfinite(sec_post_sh) else None,
            'sec_share_ratio_post_pre':sec_ratio if np.isfinite(sec_ratio) else None,
            'sec_ratio_matches_split_factor':bool(sec_factor_ok),
            'massive_post_to_sec_post':massive_post_to_sec_post if np.isfinite(massive_post_to_sec_post) else None,
            'massive_pre_to_sec_post':massive_pre_to_sec_post if np.isfinite(massive_pre_to_sec_post) else None,
            'basis_status':status,
        })
    return pd.DataFrame(records) if records else pd.DataFrame(columns=["ticker", "basis_status"])

def correct_frame(d, events, sec):
    d = d.copy()
    candidates = events[events.basis_status.eq(CORRECTABLE) | events.basis_status.str.startswith(UNKNOWN_PREFIX)]
    events_by_ticker = {t: list(g.sort_values('execution_date').itertuples(index=False))
                        for t, g in candidates.groupby('ticker', sort=False)}
    sec_by_ticker = {}
    issuance_by_ticker = {}
    if sec is not None and not sec.empty:
        sec = sec[sec.pit_status.eq('ok') & sec.shares_pit_sec.gt(0)].copy()
        sec['date_key'] = pd.to_datetime(sec.session_date).dt.strftime('%Y-%m-%d')
        sec_by_ticker = {str(t): dict(zip(g.date_key, g.shares_pit_sec.astype(float)))
                         for t, g in sec.groupby('ticker', sort=False)}
        if 'issuance_shares_reference' in sec:
            evidence = sec.dropna(subset=['issuance_shares_reference'])
            issuance_by_ticker = {str(t): dict(zip(g.date_key, g.issuance_shares_reference))
                                  for t, g in evidence.groupby('ticker', sort=False)}
    # Keep every source column as-is; the correction is carried only in appended fields.
    d['weighted_shares_outstanding_corrected']=d.weighted_shares_outstanding_used
    d['market_cap_estimated_diagnostic']=d.market_cap_estimated
    d['market_cap_estimated_corrected']=d.market_cap_estimated
    d['split_basis_multiplier_corrected']=1.0
    d['split_basis_events_applied']=''
    d['split_basis_events_uncertain']=''
    d['split_basis_uncertainty_reason']=''
    d['split_basis_issuance_evidence']=False
    d['market_cap_classification_status']=np.where(d.market_cap_estimated.notna(),'unchanged','missing_estimate')

    for ticker,idx in d.groupby('ticker',sort=False).groups.items():
        future_events = events_by_ticker.get(ticker)
        if not future_events:
            continue
        dates = pd.to_datetime(d.loc[idx, 'date']).to_numpy(dtype='datetime64[D]')
        split_dates = np.array([event.execution_date for event in future_events], dtype='datetime64[D]')
        first_future = np.searchsorted(split_dates, dates, side='right')
        old_sh=pd.to_numeric(d.loc[idx,'weighted_shares_outstanding_used'],errors='coerce').to_numpy(dtype='float64')
        close=pd.to_numeric(d.loc[idx,'close_no_adjusted'],errors='coerce').to_numpy(dtype='float64')
        old_cap=pd.to_numeric(d.loc[idx,'market_cap_estimated'],errors='coerce').to_numpy(dtype='float64')
        good_share=np.isfinite(old_sh)&(old_sh>0)
        good_cap=np.isfinite(old_cap)&(old_cap>0)
        factor=np.ones(len(idx),dtype='float64')
        applied_ids = np.full(len(idx), '', dtype=object)
        uncertain_ids = np.full(len(idx), '', dtype=object)
        uncertainty_reasons = np.full(len(idx), '', dtype=object)
        date_keys = d.loc[idx, 'date'].astype(str)
        sec_shares = date_keys.map(sec_by_ticker.get(str(ticker), {}))
        issuance = date_keys.map(issuance_by_ticker.get(str(ticker), {}))
        used_issuance = np.zeros(len(idx), dtype=bool)
        spans = pd.DataFrame({'first_future': first_future, 'massive': old_sh,
                              'sec': sec_shares.to_numpy(dtype=float),
                              'issuance': issuance.to_numpy(dtype=float)})
        # A decision is identical while the eligible future splits, the
        # monthly Massive shares and the eligible SEC shares stay the same.
        for first, split_rows in spans.groupby('first_future', sort=False):
            future = future_events[first:]
            if not future:
                continue
            all_ids = '|'.join(str(event.event_id) for event in future)
            options = [(1.0, (), False)]
            if len(future) <= 12:
                for event in future:
                    options += [(product * float(event.share_multiplier), ids + (str(event.event_id),),
                                 unknown or event.basis_status != CORRECTABLE)
                                for product, ids, unknown in options]
            for (shares, reference, bridge), rows in split_rows.groupby(['massive', 'sec', 'issuance'], sort=False, dropna=False):
                positions = rows.index.to_numpy()
                reason, identifiers = '', all_ids
                if not np.isfinite(shares) or shares <= 0 or not np.isfinite(reference):
                    reason = 'missing_sec_or_massive_shares'
                elif len(future) > 12:
                    reason = 'too_many_candidate_splits'
                else:
                    matches = [(product, ids, unknown) for product, ids, unknown in options
                               if close_to_factor(shares / reference, product, .15)]
                    if not matches and np.isfinite(bridge):
                        # Issuance can refute a stale baseline, never prove a split factor.
                        bridge_matches = [option for option in options
                                          if close_to_factor(shares / bridge, option[0], .15)]
                        if bridge_matches == [(1.0, (), False)]:
                            used_issuance[positions] = True
                            continue
                    if not matches:
                        reason = 'no_matching_share_basis'
                    elif len(matches) > 1:
                        reason = 'ambiguous_share_basis'
                        identifiers = '|'.join(sorted({eid for _, ids, _ in matches for eid in ids}))
                    else:
                        product, ids, unknown = matches[0]
                        if unknown:
                            reason = 'unconfirmed_split_factor'
                            identifiers = '|'.join(ids)
                        elif ids and not np.isclose(product, 1.0, rtol=0, atol=1e-12):
                            factor[positions] = product
                            applied_ids[positions] = '|'.join(ids)
                if reason:
                    uncertain_ids[positions] = identifiers
                    uncertainty_reasons[positions] = reason
        uncertain = uncertainty_reasons != ''

        new_sh=old_sh.copy()
        changed=~np.isclose(factor,1.0,rtol=0,atol=1e-12)
        new_sh[good_share&changed]=old_sh[good_share&changed]/factor[good_share&changed]
        new_cap=old_cap.copy()
        can_calc=changed&good_share&np.isfinite(close)&(close>0)&good_cap
        new_cap[can_calc]=close[can_calc]*new_sh[can_calc]
        new_cap[uncertain]=np.nan
        new_cap[~good_cap]=np.nan

        d.loc[idx,'weighted_shares_outstanding_corrected']=new_sh
        d.loc[idx,'market_cap_estimated_corrected']=new_cap
        d.loc[idx,'split_basis_multiplier_corrected']=factor
        d.loc[idx,'split_basis_events_applied']=applied_ids
        d.loc[idx,'split_basis_events_uncertain']=uncertain_ids
        d.loc[idx,'split_basis_uncertainty_reason']=uncertainty_reasons
        d.loc[idx,'split_basis_issuance_evidence']=used_issuance
        statuses=np.full(len(idx),'unchanged',dtype=object)
        statuses[~good_cap]='missing_estimate'
        statuses[changed&good_cap]='corrected_confirmed_split_basis'
        statuses[uncertain&good_cap]='unknown_split_basis'
        d.loc[idx,'market_cap_classification_status']=statuses

    d['market_cap_bucket_original']=bucketize(d.market_cap_estimated)
    d['market_cap_bucket_corrected']=bucketize(d.market_cap_estimated_corrected)
    return d

def bucketize(values):
    x=pd.to_numeric(values,errors='coerce')
    result=pd.Series(pd.NA,index=x.index,dtype='string')
    valid=x.notna()&np.isfinite(x)&x.gt(0)
    result.loc[valid&(x<2e9)]='Small (<$2B)'
    result.loc[valid&(x>=2e9)&(x<10e9)]='Mid ($2–10B)'
    result.loc[valid&(x>=10e9)&(x<200e9)]='Large ($10–200B)'
    result.loc[valid&(x>=200e9)]='Mega (≥$200B)'
    return result
