// Code generated-style deep-copy implementations kept in source so the API package
// remains buildable without a generation step. DO NOT EDIT mechanically.
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

func (in *T4ClusterHost) DeepCopyInto(out *T4ClusterHost) {
	*out = *in
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	in.Spec.DeepCopyInto(&out.Spec)
	in.Status.DeepCopyInto(&out.Status)
}

func (in *T4ClusterHost) DeepCopy() *T4ClusterHost {
	if in == nil {
		return nil
	}
	out := new(T4ClusterHost)
	in.DeepCopyInto(out)
	return out
}

func (in *T4ClusterHost) DeepCopyObject() runtime.Object { return in.DeepCopy() }

func (in *T4ClusterHostList) DeepCopyInto(out *T4ClusterHostList) {
	*out = *in
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]T4ClusterHost, len(in.Items))
		for i := range in.Items {
			in.Items[i].DeepCopyInto(&out.Items[i])
		}
	}
}

func (in *T4ClusterHostList) DeepCopy() *T4ClusterHostList {
	if in == nil {
		return nil
	}
	out := new(T4ClusterHostList)
	in.DeepCopyInto(out)
	return out
}

func (in *T4ClusterHostList) DeepCopyObject() runtime.Object { return in.DeepCopy() }

func (in *T4ClusterHostSpec) DeepCopyInto(out *T4ClusterHostSpec) {
	*out = *in
	if in.RuntimeProfiles != nil {
		out.RuntimeProfiles = append([]string(nil), in.RuntimeProfiles...)
	}
	if in.AllowedOrigins != nil {
		out.AllowedOrigins = append([]string(nil), in.AllowedOrigins...)
	}
	if in.CIProvider != nil {
		out.CIProvider = &CIProviderReferences{ConfigMapRef: in.CIProvider.ConfigMapRef, ServiceAccountAudience: in.CIProvider.ServiceAccountAudience}
		if in.CIProvider.SecretRef != nil {
			secret := *in.CIProvider.SecretRef
			out.CIProvider.SecretRef = &secret
		}
	}
}

func (in *T4ClusterHostStatus) DeepCopyInto(out *T4ClusterHostStatus) {
	*out = *in
	if in.Conditions != nil {
		out.Conditions = append([]metav1.Condition(nil), in.Conditions...)
	}
}

func (in *T4Workspace) DeepCopyInto(out *T4Workspace) {
	*out = *in
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	in.Spec.DeepCopyInto(&out.Spec)
	in.Status.DeepCopyInto(&out.Status)
}

func (in *T4Workspace) DeepCopy() *T4Workspace {
	if in == nil {
		return nil
	}
	out := new(T4Workspace)
	in.DeepCopyInto(out)
	return out
}

func (in *T4Workspace) DeepCopyObject() runtime.Object { return in.DeepCopy() }

func (in *T4WorkspaceList) DeepCopyInto(out *T4WorkspaceList) {
	*out = *in
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]T4Workspace, len(in.Items))
		for i := range in.Items {
			in.Items[i].DeepCopyInto(&out.Items[i])
		}
	}
}

func (in *T4WorkspaceList) DeepCopy() *T4WorkspaceList {
	if in == nil {
		return nil
	}
	out := new(T4WorkspaceList)
	in.DeepCopyInto(out)
	return out
}

func (in *T4WorkspaceList) DeepCopyObject() runtime.Object { return in.DeepCopy() }

func (in *T4WorkspaceSpec) DeepCopyInto(out *T4WorkspaceSpec) {
	*out = *in
	if in.Repository != nil {
		out.Repository = &RepositoryMetadata{RepositoryID: in.Repository.RepositoryID, Ref: in.Repository.Ref, Commit: in.Repository.Commit}
	}
	out.Size = in.Size.DeepCopy()
}

func (in *T4WorkspaceStatus) DeepCopyInto(out *T4WorkspaceStatus) {
	*out = *in
	out.Capacity = in.Capacity.DeepCopy()
	if in.Conditions != nil {
		out.Conditions = append([]metav1.Condition(nil), in.Conditions...)
	}
}

func (in *T4Session) DeepCopyInto(out *T4Session) {
	*out = *in
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	in.Spec.DeepCopyInto(&out.Spec)
	in.Status.DeepCopyInto(&out.Status)
}

func (in *T4Session) DeepCopy() *T4Session {
	if in == nil {
		return nil
	}
	out := new(T4Session)
	in.DeepCopyInto(out)
	return out
}

func (in *T4Session) DeepCopyObject() runtime.Object { return in.DeepCopy() }

func (in *T4SessionList) DeepCopyInto(out *T4SessionList) {
	*out = *in
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]T4Session, len(in.Items))
		for i := range in.Items {
			in.Items[i].DeepCopyInto(&out.Items[i])
		}
	}
}

func (in *T4SessionList) DeepCopy() *T4SessionList {
	if in == nil {
		return nil
	}
	out := new(T4SessionList)
	in.DeepCopyInto(out)
	return out
}

func (in *T4SessionList) DeepCopyObject() runtime.Object { return in.DeepCopy() }

func (in *T4SessionSpec) DeepCopyInto(out *T4SessionSpec) {
	*out = *in
	if in.InitialPromptSecretRef != nil {
		copy := *in.InitialPromptSecretRef
		out.InitialPromptSecretRef = &copy
	}
	if in.CI != nil {
		out.CI = &SessionCIMetadata{RepositoryID: in.CI.RepositoryID, Ref: in.CI.Ref, Commit: in.CI.Commit}
	}
}

func (in *T4SessionStatus) DeepCopyInto(out *T4SessionStatus) {
	*out = *in
	if in.Conditions != nil {
		out.Conditions = append([]metav1.Condition(nil), in.Conditions...)
	}
}
